/**
 * /api/billing/*: Stripe Checkout, the webhook and the Billing Portal (see functions/_stripe.ts).
 * More specific than the catch-all proxy, so it wins for these paths; with PAYWALL_ENABLED off it
 * answers the proxy's own 404, the webhook included.
 */
import { handleBilling, type BillingCtx } from '../../_stripe';

export const onRequest = (ctx: BillingCtx): Promise<Response> => handleBilling(ctx);
