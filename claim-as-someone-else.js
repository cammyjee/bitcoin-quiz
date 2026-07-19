import { PrivateKey, Transaction, P2PKH, LockingScript, UnlockingScript, OP, Hash, SatoshisPerKilobyte } from '@bsv/sdk'
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis

const API = 'https://api.whatsonchain.com/v1/bsv/main'
const UI = 'https://whatsonchain.com'
const fee = new SatoshisPerKilobyte(100)

async function wocFetch(url, opts) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, opts)
    if (r.status !== 429 || attempt >= 4) return r
    const wait = attempt * 3000
    console.log(`  (WhatsOnChain rate-limited us — waiting ${wait / 1000}s, retry ${attempt}/3…)`)
    await new Promise(res => setTimeout(res, wait))
  }
}

const getHex = async id => {
  const r = await wocFetch(`${API}/tx/${id}/hex`)
  if (!r.ok) throw new Error(`hex ${id} -> ${r.status}`)
  return (await r.text()).trim()
}

const broadcast = async hex => {
  const r = await wocFetch(`${API}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: hex })
  })
  const b = await r.text()
  if (!r.ok) throw new Error(`broadcast: ${b}`)
  return b.trim().replace(/"/g, '')
}

const puzzleUnlock = answer => {
  const bytes = [...Buffer.from(answer, 'utf8')]
  return {
    sign: async () => new UnlockingScript([{ op: bytes.length, data: bytes }]),
    estimateLength: async () => bytes.length + 1
  }
}

async function run() {
  // 1. Generate a new key/address (representing "someone else")
  const recipientKey = PrivateKey.fromRandom()
  const recipientAddr = recipientKey.toPublicKey().toAddress()
  console.log(`Generated new address for "someone else": ${recipientAddr}`)
  console.log(`Private key (WIF): ${recipientKey.toWif()}`)

  const puzzleTxid = 'f9f7880530881d1e7435d8d85ed579e834ba41ffc8430fa6fc57802c153bda6d'
  const answer = 'one'

  console.log(`\nFetching puzzle tx: ${puzzleTxid}`)
  const srcTx = Transaction.fromHex(await getHex(puzzleTxid))
  
  console.log(`Building claim transaction to spend output 0...`)
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: puzzleUnlock(answer)
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(recipientAddr),
    change: true
  })
  
  await tx.fee(fee)
  await tx.sign()
  
  console.log(`Broadcasting transaction...`)
  const txid = await broadcast(tx.toHex())
  console.log(`\n💰 Claimed successfully!`)
  console.log(`Transaction ID: ${txid}`)
  console.log(`Explorer link: ${UI}/tx/${txid}`)
}

run().catch(console.error)
