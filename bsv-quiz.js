#!/usr/bin/env node
// bsv-quiz.js — lock sats behind a quiz question; whoever knows the answer claims them.
// ─────────────────────────────────────────────────────────────────────────────
// Same hash-puzzle mechanics, reframed as a quiz:
//   LOCK:   OP_SHA256 <sha256(answer)> OP_EQUAL   ← the question, committed on-chain
//   UNLOCK: <answer>                              ← the right answer takes the prize (NO key!)
//
// HOST (you):    node bsv-quiz.js create [--broadcast]
// ANYONE:        node bsv-quiz.js claim <puzzleTxid> "<answer>" <yourAddress> [--broadcast]
//
// Both DRY-RUN by default. Add --broadcast to actually send.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto           // @bsv/sdk ESM needs a CSPRNG…
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis   // …and `self` to reach it
import { PrivateKey, Transaction, P2PKH, LockingScript, UnlockingScript, OP, Hash, SatoshisPerKilobyte } from '@bsv/sdk'

const HERE = path.dirname(fileURLToPath(import.meta.url))   // so the key is found next to the script, not wherever you run from

// ═══ CONFIG ══════════════════════════════════════════════════════════════════
const NETWORK  = 'main'                                   // 'main' | 'test'
const QUESTION = "How many Global chains did Satoshi intend there to be?"  // shown to players
const ANSWER   = 'one'                                     // exact bytes. Keep it lowercase/simple.
const BOUNTY   = 700                                      // sats to lock as the prize

// derived
const IS_MAIN = NETWORK === 'main'
const API = `https://api.whatsonchain.com/v1/bsv/${IS_MAIN ? 'main' : 'test'}`
const UI  = IS_MAIN ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com'
const ADDR_PREFIX = IS_MAIN ? [0x00] : [0x6f]
const fee = new SatoshisPerKilobyte(100)
const TREASURY_FILE = path.join(HERE, `treasury-${NETWORK}.wif`)   // next to THIS script, so cwd doesn't matter

const argv = process.argv.slice(2)
const BROADCAST = argv.includes('--broadcast')
const args = argv.filter(a => a !== '--broadcast')
const MODE = args[0]

// ═══ chain read / write (same API, different endpoints) ══════════════════════
// wocFetch auto-retries when WhatsOnChain rate-limits us (HTTP 429) — a throttle
// shouldn't kill you mid-demo. Waits a few seconds, tries again, a few times.
async function wocFetch (url, opts) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, opts)
    if (r.status !== 429 || attempt >= 4) return r
    const wait = attempt * 3000
    console.log(`  (WhatsOnChain rate-limited us — waiting ${wait / 1000}s, retry ${attempt}/3…)`)
    await new Promise(res => setTimeout(res, wait))
  }
}
const getJson = async p => { const r = await wocFetch(API + p); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json() }
const getHex  = async id => { const r = await wocFetch(`${API}/tx/${id}/hex`); if (!r.ok) throw new Error(`hex ${id} -> ${r.status}`); return (await r.text()).trim() }
const broadcast = async hex => {
  const r = await wocFetch(`${API}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }) })
  const b = await r.text(); if (!r.ok) throw new Error(`broadcast: ${b}`); return b.trim().replace(/"/g, '')
}

// ═══ the quiz script ═════════════════════════════════════════════════════════
const hashOf = s => Hash.sha256([...Buffer.from(s, 'utf8')])
const puzzleLock = answerHash => new LockingScript([
  { op: OP.OP_SHA256 }, { op: answerHash.length, data: answerHash }, { op: OP.OP_EQUAL }
])
const puzzleUnlock = answer => {                    // unlock = just the answer. No signature, no key.
  const bytes = [...Buffer.from(answer, 'utf8')]
  return { sign: async () => new UnlockingScript([{ op: bytes.length, data: bytes }]), estimateLength: async () => bytes.length + 1 }
}
const wocScriptHash = lock => Hash.sha256(lock.toBinary()).reverse().map(b => b.toString(16).padStart(2, '0')).join('')

// ───────────────────────────────────────────────────────────────────────────
async function create () {
  if (!fs.existsSync(TREASURY_FILE)) throw new Error(`no treasury yet — run "node 00-create-your-wallet.js" first, then fund it`)
  const treasury = PrivateKey.fromWif(fs.readFileSync(TREASURY_FILE, 'utf8').trim())
  const treasuryAddr = treasury.toPublicKey().toAddress(ADDR_PREFIX)

  const utxos = await getJson(`/address/${treasuryAddr}/unspent`)
  if (!utxos.length) throw new Error(`treasury ${treasuryAddr} has no coins — fund it first`)
  const u = utxos.sort((a, b) => b.value - a.value)[0]
  const srcTx = Transaction.fromHex(await getHex(u.tx_hash))

  const lock = puzzleLock(hashOf(ANSWER))
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: srcTx, sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(treasury) })
  tx.addOutput({ lockingScript: lock, satoshis: BOUNTY })                      // the prize, locked to the answer
  tx.addOutput({ lockingScript: new P2PKH().lock(treasuryAddr), change: true }) // your change comes home
  await tx.fee(fee); await tx.sign()

  console.log(`\n== CREATE quiz (${NETWORK}net, ${BROADCAST ? 'BROADCAST' : 'DRY RUN'}) ==`)
  console.log(`Question : ${QUESTION}`)
  console.log(`Prize    : ${BOUNTY} sats   (change ${tx.outputs[1].satoshis} sats back to you)`)
  console.log(`Lock     : ${lock.toASM()}`)   // note: the ANSWER is NOT shown — only its hash is public
  console.log(`Puzzle at: <txid>:0  (once broadcast)  |  scriptHash ${wocScriptHash(lock)}`)
  if (!BROADCAST) { console.log(`\nDRY RUN — not sent. Hex:\n  ${tx.toHex()}\n\nRe-run with --broadcast to post the quiz.`); return }
  const id = await broadcast(tx.toHex())
  console.log(`\n✅ Quiz is live: ${UI}/tx/${id}`)
  console.log(`Players claim with:\n  node bsv-quiz.js claim ${id} "<answer>" <theirAddress> --broadcast`)
}

// ───────────────────────────────────────────────────────────────────────────
async function claim (puzzleTxid, answer, destAddr) {
  if (!puzzleTxid || !answer || !destAddr) throw new Error(`usage: claim <puzzleTxid> "<answer>" <yourAddress> [--broadcast]`)
  const srcTx = Transaction.fromHex(await getHex(puzzleTxid))
  const lock = srcTx.outputs[0].lockingScript
  const committed = lock.chunks[1].data                    // the <hash> between OP_SHA256 and OP_EQUAL

  const mine = hashOf(answer)
  const match = committed.length === mine.length && committed.every((b, i) => b === mine[i])
  console.log(`\n== CLAIM (${NETWORK}net, ${BROADCAST ? 'BROADCAST' : 'DRY RUN'}) ==`)
  console.log(`Your answer hashes to : ${Buffer.from(mine).toString('hex').slice(0, 20)}…`)
  console.log(`Puzzle wants          : ${Buffer.from(committed).toString('hex').slice(0, 20)}…`)
  if (!match) { console.log(`\n❌ Wrong answer — hashes don't match. Nothing built.`); return }
  console.log(`✅ Correct — the answer satisfies the lock.`)
  console.log(`   Now building the transaction that spends the puzzle's locked coins to ${destAddr}.`)
  console.log(`   No private key needed: the answer alone authorizes this spend.`)

  const tx = new Transaction()
  tx.addInput({ sourceTransaction: srcTx, sourceOutputIndex: 0, unlockingScriptTemplate: puzzleUnlock(answer) })
  tx.addOutput({ lockingScript: new P2PKH().lock(destAddr), change: true })
  await tx.fee(fee); await tx.sign()
  console.log(`Unlock : ${tx.inputs[0].unlockingScript.toASM()}   (just the answer)`)
  console.log(`Payout : ${tx.outputs[0].satoshis} sats -> ${destAddr}`)
  if (!BROADCAST) { console.log(`\nDRY RUN — not sent. Hex:\n  ${tx.toHex()}\n\nRe-run with --broadcast to claim.`); return }
  const id = await broadcast(tx.toHex())
  console.log(`\n💰 Claimed: ${UI}/tx/${id}`)
}

// ───────────────────────────────────────────────────────────────────────────
const run = MODE === 'create' ? create()
  : MODE === 'claim' ? claim(args[1], args[2], args[3])
  : Promise.reject(new Error(`usage:\n  node bsv-quiz.js create [--broadcast]\n  node bsv-quiz.js claim <puzzleTxid> "<answer>" <yourAddress> [--broadcast]`))
run.catch(e => { console.error('❌', e.message || e); process.exit(1) })
