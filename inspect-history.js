import fs from 'fs'
import { PrivateKey, Transaction } from '@bsv/sdk'

const API = 'https://api.whatsonchain.com/v1/bsv/main'

async function run() {
  const address = '1KDd2HYHbfMdGd7HV3QAWaEquoKbZinmFc'
  console.log('Fetching history for address:', address)
  
  const historyRes = await fetch(`${API}/address/${address}/history`)
  if (!historyRes.ok) {
    throw new Error(`Failed to fetch history: ${historyRes.statusText}`)
  }
  const history = await historyRes.json()
  console.log(`Found ${history.length} transactions in history.`)

  for (const txInfo of history) {
    const txid = txInfo.tx_hash
    console.log(`\nInspecting TxID: ${txid}`)
    const txHexRes = await fetch(`${API}/tx/${txid}/hex`)
    if (!txHexRes.ok) {
      console.log(`Failed to fetch hex for ${txid}`)
      continue
    }
    const hex = (await txHexRes.text()).trim()
    const tx = Transaction.fromHex(hex)
    
    // Look at outputs
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i]
      const scriptASM = output.lockingScript.toASM()
      console.log(`  Output ${i}: val=${output.satoshis} sats | Script: ${scriptASM}`)
    }
  }
}

run().catch(console.error)
