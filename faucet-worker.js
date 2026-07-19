/**
 * Cloudflare Worker: BSV Quiz Faucet Backend
 * 
 * This script runs at the edge. It receives a client's answer and address,
 * verifies it privately, constructs a transaction from your treasury,
 * signs it using your private key (stored securely in Worker Secrets),
 * and broadcasts the payment.
 * 
 * SETUP INSTRUCTIONS:
 * 1. Initialize wrangler in this directory:
 *    npx wrangler init
 * 2. Deploy the worker:
 *    npx wrangler deploy
 * 3. Add your private key to your remote secrets (DO NOT put it in code or git):
 *    npx wrangler secret put TREASURY_WIF
 * 4. Add your Turnstile CAPTCHA secret key (optional but recommended):
 *    npx wrangler secret put TURNSTILE_SECRET_KEY
 */

import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';

const ANSWER_HASH = "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed"; // SHA-256 of "one"
const BOUNTY_SATS = 700;
const FEE_RATE = new SatoshisPerKilobyte(100);

export default {
  async fetch(request, env, ctx) {
    // Enable CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
    }

    try {
      const { answer, address, captchaToken } = await request.json();

      if (!answer || !address) {
        return new Response(JSON.stringify({ error: 'Missing answer or payout address.' }), { status: 400, headers: corsHeaders });
      }

      // 1. CAPTCHA Verification (Optional if TURNSTILE_SECRET_KEY is configured)
      if (env.TURNSTILE_SECRET_KEY) {
        if (!captchaToken) {
          return new Response(JSON.stringify({ error: 'Missing CAPTCHA verification token.' }), { status: 400, headers: corsHeaders });
        }
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret: env.TURNSTILE_SECRET_KEY,
            response: captchaToken,
            remoteip: request.headers.get('CF-Connecting-IP'),
          })
        });
        const verifyJson = await verifyRes.json();
        if (!verifyJson.success) {
          return new Response(JSON.stringify({ error: 'CAPTCHA verification failed. Bots are blocked.' }), { status: 400, headers: corsHeaders });
        }
      }

      // 2. Simple rate limiting using Cloudflare Workers KV (Optional: bind a KV namespace named FAUCET_KV)
      if (env.FAUCET_KV) {
        const ip = request.headers.get('CF-Connecting-IP') || 'anonymous';
        const hasClaimed = await env.FAUCET_KV.get(`claim:${ip}`);
        if (hasClaimed) {
          return new Response(JSON.stringify({ error: 'You have already claimed a bounty today. Try again tomorrow.' }), { status: 429, headers: corsHeaders });
        }
        // Save the rate limit marker for 24 hours (86400 seconds)
        await env.FAUCET_KV.put(`claim:${ip}`, 'true', { expirationTtl: 86400 });
      }

      // 3. Verify the answer
      const encoder = new TextEncoder();
      const data = encoder.encode(answer.trim().toLowerCase());
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const inputHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      if (inputHash !== ANSWER_HASH) {
        return new Response(JSON.stringify({ error: 'Incorrect answer. Try again.' }), { status: 400, headers: corsHeaders });
      }

      // 4. Retrieve Treasury Key from environment secrets
      if (!env.TREASURY_WIF) {
        return new Response(JSON.stringify({ error: 'Faucet treasury configuration error. Please contact host.' }), { status: 500, headers: corsHeaders });
      }

      const treasury = PrivateKey.fromWif(env.TREASURY_WIF);
      const treasuryAddr = treasury.toPublicKey().toAddress().toString();

      // 5. Fetch Treasury UTXOs from WhatsOnChain
      const utxoRes = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${treasuryAddr}/unspent`);
      if (!utxoRes.ok) throw new Error('Failed to fetch treasury UTXOs');
      const utxos = await utxoRes.json();
      if (!utxos || utxos.length === 0) {
        return new Response(JSON.stringify({ error: 'Faucet treasury is empty! Please notify the administrator.' }), { status: 500, headers: corsHeaders });
      }

      // Sort UTXOs by value descending
      const sortedUtxos = utxos.sort((a, b) => b.value - a.value);

      // Add inputs until we have enough to cover the bounty + estimated fee
      const tx = new Transaction();
      let inputSum = 0;
      const targetMin = BOUNTY_SATS + 100; // bounty + 100 sats safety buffer for fees

      for (const u of sortedUtxos) {
        // Fetch the full hex of the transaction being spent
        const srcHexRes = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${u.tx_hash}/hex`);
        if (!srcHexRes.ok) throw new Error(`Failed to fetch source transaction hex for ${u.tx_hash}`);
        const srcHex = (await srcHexRes.text()).trim();
        const srcTx = Transaction.fromHex(srcHex);

        tx.addInput({
          sourceTransaction: srcTx,
          sourceOutputIndex: u.tx_pos,
          unlockingScriptTemplate: new P2PKH().unlock(treasury)
        });

        inputSum += u.value;
        if (inputSum >= targetMin) {
          break; // We have enough inputs
        }
      }

      if (inputSum < BOUNTY_SATS) {
        return new Response(JSON.stringify({ error: `Insufficient treasury funds. Has ${inputSum} sats, needs at least ${BOUNTY_SATS} sats.` }), { status: 500, headers: corsHeaders });
      }

      // Build the payment transaction (Treasury -> User)
      tx.addOutput({
        lockingScript: new P2PKH().lock(address),
        satoshis: BOUNTY_SATS
      });
      // Send the remainder back as change to the treasury
      tx.addOutput({
        lockingScript: new P2PKH().lock(treasuryAddr),
        change: true
      });

      await tx.fee(FEE_RATE);
      await tx.sign();

      // 7. Broadcast the transaction hex
      const broadcastRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: tx.toHex() })
      });
      const resText = await broadcastRes.text();
      if (!broadcastRes.ok) throw new Error(`WhatsOnChain broadcast failed: ${resText}`);

      const txid = resText.trim().replace(/"/g, '');

      return new Response(JSON.stringify({ success: true, txid }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message || 'Internal server error during claiming.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
