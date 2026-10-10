// Payment gateway abstraction. Everything that talks to "the bank / PSP" goes through this object,
// so going live means replacing the body of these functions (e.g. with Razorpay or Cashfree:
// create order -> client checkout -> verify signature / webhook -> capture) — routes and UI stay as they are.
//
// The built-in provider is a SANDBOX: it moves a payment through processing -> verification on a
// timer, like a real gateway's async callbacks. No money moves and no bank is contacted.
export const SANDBOX = { name: 'sandbox', label: 'Sandbox (test mode)', live: false };
export const PROCESSING_MS = Number(process.env.PAY_PROCESSING_MS) || 2500;
export const VERIFY_MS = Number(process.env.PAY_VERIFY_MS) || 2500;

export const gateway = {
  ...SANDBOX,
  // Where is an authorised payment in the gateway's pipeline? -> 'processing' | 'verifying' | 'captured'
  phase(payment, now = Date.now()) {
    const elapsed = now - new Date(payment.processingAt || now).getTime();
    if (elapsed < PROCESSING_MS) return 'processing';
    if (elapsed < PROCESSING_MS + VERIFY_MS) return 'verifying';
    return 'captured';
  },
  // Refunds are completed manually by the admin in the sandbox; a live provider would call its refund API here.
  async refund() { return { ok: true, provider: SANDBOX.name }; }
};
