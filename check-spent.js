import { Transaction, Hash } from '@bsv/sdk'

const API = 'https://api.whatsonchain.com/v1/bsv/main'

const wocScriptHash = lock => Hash.sha256(lock.toBinary()).reverse().map(b => b.toString(16).padStart(2, '0')).join('')

async function run() {
  const txid = 'f9f7880530881d1e7435d8d85ed579e834ba41ffc8430fa6fc57802c153bda6d'
  const txHexRes = await fetch(`${API}/tx/${txid}/hex`)
  if (!txHexRes.ok) {
    throw new Error(`Failed to fetch hex for ${txid}`)
  }
  const hex = (await txHexRes.text()).trim()
  const tx = Transaction.fromHex(hex)
  
  const lock = tx.outputs[0].lockingScript
  const sh = wocScriptHash(lock)
  console.log('Script Hash:', sh)
  
  const utxoRes = await fetch(`${API}/script/${sh}/unspent`)
  if (!utxoRes.ok) {
    throw new Error(`Failed to fetch UTXOs: ${utxoRes.status}`)
  }
  const utxos = await utxoRes.json()
  console.log('UTXOs for this script hash:', JSON.stringify(utxos, null, 2))
}

run().catch(console.error)
