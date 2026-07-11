#!/usr/bin/env node
// 00-create-your-wallet.js — make your "wallet": a single private key.
// ─────────────────────────────────────────────────────────────────────────────
// A wallet, at its atom, is just a private key. This makes one, saves it to a
// .wif file, and prints its address so you can fund it. That's Step 1 — the other
// scripts (hash puzzle, quiz) all spend from the wallet this creates.
//
//   node 00-create-your-wallet.js
//
// ⚠️  READ THIS — it involves REAL money:
//   • This is BSV MAINNET. Anything you send to this address is REAL.
//   • Fund it with SUB-PENNIES only. One cent lasts thousands of these lessons.
//   • NEVER store anything of value here. It's a toy for learning, nothing more.
//   • NEVER commit or share your .wif file. Whoever holds it OWNS the coins.
//     (This repo's .gitignore already excludes *.wif — leave that in place.)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto           // @bsv/sdk ESM needs a CSPRNG…
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis   // …and `self` to reach it
import { PrivateKey } from '@bsv/sdk'

const HERE = path.dirname(fileURLToPath(import.meta.url))   // key lives next to the script, not wherever you run from

const NETWORK = 'main'                                    // 'main' | 'test'
const ADDR_PREFIX = NETWORK === 'main' ? [0x00] : [0x6f]  // P2PKH version byte
const FILE = path.join(HERE, `treasury-${NETWORK}.wif`)   // next to THIS script, so cwd doesn't matter

function warn () {
  console.log(`\n⚠️  REAL MONEY. This key lives on BSV ${NETWORK === 'main' ? 'MAINNET' : 'testnet'}.`)
  console.log(`    • Fund with SUB-PENNIES only — never store anything of value here.`)
  console.log(`    • NEVER commit or share ${FILE}. Whoever holds it owns the coins.\n`)
}

// SAFETY: never overwrite an existing key — it might already be funded.
if (fs.existsSync(FILE)) {
  const key = PrivateKey.fromWif(fs.readFileSync(FILE, 'utf8').trim())
  console.log(`\nYou already have a wallet: ${FILE}`)
  console.log(`Address: ${key.toPublicKey().toAddress(ADDR_PREFIX)}`)
  console.log(`(To make a fresh one, delete ${FILE} yourself — but confirm it's empty first!)`)
  warn()
  process.exit(0)
}

const key = PrivateKey.fromRandom()
fs.writeFileSync(FILE, key.toWif())
const address = key.toPublicKey().toAddress(ADDR_PREFIX)

console.log(`\n✅ New wallet created — it's just one private key.`)
console.log(`   Saved to     : ${FILE}   (this file IS your wallet — guard it)`)
console.log(`   Your address : ${address}`)
console.log(`\nFund it by sending a few hundred sats (a fraction of a cent) to that`)
console.log(`address from any BSV wallet — HandCash, Electrum SV, etc.`)
warn()
