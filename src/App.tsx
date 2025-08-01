import { useState } from 'react';
import { Mnemonic, HD, PrivateKey, PublicKey, P2PKH, Transaction, Utils, Script, WalletClient, type TransactionInput, type CreateActionInput } from '@bsv/sdk';
import './App.css';


/** FIFO queue for throttling API requests to max 3 per second */
const requestQueue: { url: string; resolve: (value: Response) => void; reject: (reason?: any) => void; }[] = [];

let isProcessing = false;

let lastRequestTime = 0;

const MIN_INTERVAL = 334; // ms for ~3 requests per second

const wallet = new WalletClient()

async function queuedFetch(url: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    if (!isProcessing) {
      processQueue();
    }
  });
}

async function processQueue() {
  isProcessing = true;
  while (requestQueue.length > 0) {
    const now = Date.now();
    const timeSinceLast = now - lastRequestTime;
    if (timeSinceLast < MIN_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - timeSinceLast));
    }
    lastRequestTime = Date.now();
    const item = requestQueue.shift()!;
    try {
      const response = await fetch(item.url);
      item.resolve(response);
    } catch (error) {
      item.reject(error);
    }
  }
  isProcessing = false;
}

interface wocUTXO {
  height: number;
  tx_pos: number;
  tx_hash: string;
  value: number;
  isSpentInMempoolTx: boolean;
}

interface utxoResponse {
  address: string;
  error: string;
  result: wocUTXO[];
  script: string;
}

interface Result {
  index: number;
  address: string;
  balance: number;
  count: number;
  utxos: utxoResponse;
}

function App() {
  const [mnemonic, setMnemonic] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [pathPrefix, setPathPrefix] = useState<string>("m/44'/0/0");
  const [results, setResults] = useState<Result[]>([]);
  const [txHex, setTxHex] = useState<string>('');
  const [isLoading, setIsLoading] = useState<string>('');

const [consecutiveUnusedGap, setConsecutiveUnusedGap] = useState<number>(5);

const [startOffset, setStartOffset] = useState<number>(0);

const generateAddresses = async () => {
  setIsLoading('Generating seed...');
    let seed: number[];
    try {
      const mn = new Mnemonic(mnemonic);
      seed = mn.toSeed(pin);
    } catch (e) {
      alert('Invalid mnemonic or PIN');
      return;
    }

    const masterKey = HD.fromSeed(seed);
  setIsLoading('Searching for used addresses...');

    let index = startOffset;
    let consecutiveUnused = 0;
    const usedResults: Result[] = [];

    while (consecutiveUnused < consecutiveUnusedGap) {
      try {
        const fullPath = `${pathPrefix}/${index}`.replace(/’/g, "'");
        const childKey  = masterKey.derive(fullPath);
        const privKey = childKey.privKey as PrivateKey;
        const pubKey = privKey.toPublicKey() as PublicKey;
        const address = pubKey.toAddress().toString();
        console.log({ address })
        setIsLoading(`Checking address ${index}: ${address}`);

        // Check if ever used (using history length > 0)
        const historyRes = await queuedFetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/history`);
        const history = await historyRes.json();
        const isUsed = history.length > 0;

        if (isUsed) {
          // Fetch current UTXOs
          const unspentRes = await queuedFetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent/all`);
          const utxos = await unspentRes.json();
          if (utxos.result.length > 0) {
            console.log('success')
            const balance = utxos.result.reduce((sum: number, utxo: { value: number }) => sum + utxo.value, 0);
            usedResults.push({ index, address, balance, count: utxos.result.length, utxos });
          }
          consecutiveUnused = 0;
        } else {
          consecutiveUnused++;
        }
        index++;
      } catch (error) {
        console.error({ error })
        break
      }
    }

    setResults(r => {
      const set = new Set()
      r.forEach(r => set.add(r.address))
      usedResults.forEach(r => set.add(r.address))
      const uniqueResults = [...set]
      const updatedResults = uniqueResults.map(address => r.find(r => r.address === address) || usedResults.find(r => r.address === address) || undefined)
      return updatedResults.filter(r => r !== undefined)
    });
    setTxHex('');
    setIsLoading('');
  };

  const createIngestTx = async () => {
    try {
      const { authenticated } = await wallet.isAuthenticated();
      if (!authenticated) {
        alert('Unable to connect to wallet, please download Metanet Desktop from https://metanet.bsvb.tech and use Chrome');
        return;
      }
    } catch (error) {
      alert('Unable to connect to wallet, please download Metanet Desktop from https://metanet.bsvb.tech and use Chrome');
      return;
    }
    if (results.length === 0) {
      alert('No outputs found to ingest');
      return;
    }
    try {
      setIsLoading('Creating ingest transaction...');
      console.log({ results })

      const seed = new Mnemonic().fromString(mnemonic).toSeed(pin);
      const masterKey = HD.fromSeed(seed);

      // Collect all UTXOs with their details
      const utxosByTxid: { [key: string]: { vout: number; privKey: PrivateKey; value: number }[] } = {};
      results.forEach(res => {
        const fullPath = `${pathPrefix}/${res.index}`.replace(/’/g, "'");
        const childKey = masterKey.derive(fullPath);
        const privKey = childKey.privKey as PrivateKey;

        res.utxos.result.forEach((utxo: { tx_hash: string; tx_pos: number; value: number }) => {
          const txid = utxo.tx_hash;
          if (!utxosByTxid[txid]) {
            utxosByTxid[txid] = [];
          }
          utxosByTxid[txid].push({ vout: utxo.tx_pos, privKey, value: utxo.value });
        });
      });

      const tx = new Transaction(1, []);
      tx.addOutput({
        satoshis: 1,
        lockingScript: Script.fromASM('OP_NOP')
      })

      for (const [txid, utxoList] of Object.entries(utxosByTxid)) {
        setIsLoading(`Fetching BEEF for txid ${txid}...`);
        const beefRes = await queuedFetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/beef`);
        const beefHex = await beefRes.text();
        const beefBytes = Utils.toArray(beefHex, 'hex'); // Adjusted to fromHex assuming it returns bytes
        const sourceTx = Transaction.fromBEEF(beefBytes);

        utxoList.forEach(utxo => {
          const template = new P2PKH().unlock(utxo.privKey, 'none', true);
          tx.addInput({
            sourceTransaction: sourceTx,
            sourceOutputIndex: utxo.vout,
            unlockingScriptTemplate: template
          });
        });
      }

      setIsLoading('Signing Tx');
      await tx.sign();

      setIsLoading('Sending Tx to WalletClient')    
      const response = await wallet.createAction({
        inputBEEF: tx.toAtomicBEEF(),
        description: 'Ingesting Swept funds from mnemonic',
        inputs: tx.inputs.map<CreateActionInput>((input: TransactionInput) => ({
          inputDescription: 'from mnemonic',
          unlockingScript: input.unlockingScript!.toHex(),
          outpoint: input.sourceTransaction!.id('hex') + '.' + String(input.sourceOutputIndex)
        }))
      })

      setTxHex(Transaction.fromBEEF(response.tx as number[]).toHex())
    } catch (error) {
      console.error({ error })
    } finally {
      setIsLoading('');
    }
  };

  return (
    <div className="app-container">
      <h1>Mnemonic to BRC-100</h1>
<form className="input-form">
  <div className="form-group">
    <label>Mnemonic:</label>
    <textarea className="form-input" value={mnemonic} onChange={e => setMnemonic(e.target.value)} />
  </div>
  <div className="form-group">
    <label>PIN:</label>
    <input className="form-input" type="password" value={pin} onChange={e => setPin(e.target.value)} />
  </div>
  <div className="form-group">
    <label>Derivation Path Prefix:</label>
    <input className="form-input" value={pathPrefix} onChange={e => setPathPrefix(e.target.value)} />
  </div>
  <div className="form-group">
    <label>Consecutive Unused Gap:</label>
    <input className="form-input" type="number" value={consecutiveUnusedGap} onChange={e => setConsecutiveUnusedGap(parseInt(e.target.value) || 0)} />
  </div>
  <div className="form-group">
    <label>Start Offset:</label>
    <input className="form-input" type="number" value={startOffset} onChange={e => setStartOffset(parseInt(e.target.value) || 0)} />
  </div>
  <button className="primary-button" onClick={generateAddresses} disabled={!!isLoading}>Derive and Check Balance of Addresses</button>
</form>
      {isLoading && <p>{isLoading}</p>}
{results.length > 0 && (
  <div className="results-container">
    <table className="utxo-table">
      <thead>
        <tr>
          <th>Index</th>
          <th>Address</th>
          <th>Balance (sat)</th>
          <th>UTXO Count</th>
        </tr>
      </thead>
      <tbody>
        {results.map((res, i) => (
          <tr key={i}>
            <td>{res.index}</td>
            <td>{res.address}</td>
            <td>{res.balance}</td>
            <td>{res.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <button className="primary-button" onClick={createIngestTx} disabled={!!isLoading}>Sweep Into My Local Wallet</button>
  </div>
)}
{txHex && <div className="tx-result">
  <a className="tx-link" href={`https://whatsonchain.com/tx/${Transaction.fromHex(txHex).id('hex')}`} target="_blank">View on What's On Chain</a>
  <pre className="tx-hex">{txHex}</pre>
</div>}
    </div>
  );
}

export default App;
