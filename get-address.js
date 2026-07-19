import fs from 'fs'
import { PrivateKey } from '@bsv/sdk'

const wif = fs.readFileSync('./treasury-main.wif', 'utf8').trim()
const key = PrivateKey.fromWif(wif)
console.log('Address:', key.toPublicKey().toAddress())
