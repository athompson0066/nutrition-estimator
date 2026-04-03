// Proper PayPal Checkout Flow - Create Order
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://irlxxeoocqktiuulfuqb.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpbXF1ZWxsZ2R0bW50eXJpZGp2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczOTE3MDk3MCwiZXhwIjoyMDU0NzQ2OTcwfQ.CkKe9CJUg-jLbUR-5A3rG64nbSws1OB7xTNS9NEi4I8'
);

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'AZoLL22xCqUIuxF_fBKFvDstSpMU3k7JNRTlpJUbOQZMuem7JKrqJj9nVxw4lmkDtIpM5KefKIxPs5Wv';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || 'EO-ZKyDJ2Jmny6xW_Lbw8dtmkmq0dRCJI5C2HKHf1w-WvljKeyPVH9uocj-4VrRBaZAiOk9Cv07LU_Da';
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API = PAYPAL_MODE === 'live' 
  ? 'https://api-m.paypal.com' 
  : 'https://api-m.sandbox.paypal.com';

// Get PayPal access token
async function getPayPalToken() {
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  
  const data = await response.json();
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { leadId, plan } = req.body;

  if (!leadId || !plan) {
    return res.status(400).json({ error: 'Missing leadId or plan' });
  }

  try {
    // Get lead details
    const { data: lead, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();

    if (error || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const token = await getPayPalToken();

    let orderData;

    // Plan configurations
    const plans = {
      'saas': {
        intent: 'SUBSCRIPTION',
        plan: {
          product_id: process.env.PAYPAL_SAAS_PRODUCT_ID, // Create in PayPal Dashboard
          name: 'MacroPWA SaaS Platform',
          description: 'Monthly access to branded macro calculator',
          billing_cycles: [{
            frequency: { interval_unit: 'MONTH', interval_count: 1 },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0, // Unlimited
            pricing_scheme: {
              fixed_price: { value: '49.00', currency_code: 'USD' }
            }
          }],
          payment_preferences: {
            auto_bill_outstanding: true,
            setup_fee: { value: '0', currency_code: 'USD' },
            setup_fee_failure_action: 'CONTINUE',
            payment_failure_threshold: 3
          }
        }
      },
      'done-for-you': {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: '297.00'
          },
          description: 'MacroPWA Custom PWA - One Time'
        }]
      },
      'premium': {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: '497.00'
          },
          description: 'MacroPWA Premium Package - One Time'
        }]
      }
    };

    const planConfig = plans[plan] || plans['saas'];

    if (plan === 'saas') {
      // Create subscription (use existing plan ID from PayPal)
      const response = await fetch(`${PAYPAL_API}/v1/billing/subscriptions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          plan_id: process.env.PAYPAL_SAAS_PLAN_ID, // The plan ID from PayPal
          start_time: new Date(Date.now() + 60000).toISOString(), // Start 1 min from now
          subscriber: {
            name: { given_name: lead.name.split(' ')[0], surname: lead.name.split(' ').slice(1).join(' ') },
            email_address: lead.email
          },
          application_context: {
            brand_name: 'MacroPWA',
            locale: 'en-US',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'SUBSCRIBE_NOW',
            return_url: `https://your-domain.com/payment-success?leadId=${leadId}`,
            cancel_url: `https://your-domain.com/payment-cancelled?leadId=${leadId}`
          }
        })
      });

      const data = await response.json();
      
      // Save subscription ID to lead
      await supabase
        .from('leads')
        .update({ 
          paypal_subscription_id: data.id,
          paypal_approval_url: data.links.find(l => l.rel === 'approve')?.href
        })
        .eq('id', leadId);

      return res.status(200).json({
        success: true,
        subscriptionId: data.id,
        approvalUrl: data.links.find(l => l.rel === 'approve')?.href
      });

    } else {
      // One-time purchase
      const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: planConfig.purchase_units,
          application_context: {
            brand_name: 'MacroPWA',
            locale: 'en-US',
            landing_page: 'BILLING',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: `https://your-domain.com/payment-success?leadId=${leadId}`,
            cancel_url: `https://your-domain.com/payment-cancelled?leadId=${leadId}`
          }
        })
      });

      const data = await response.json();
      
      // Save order ID to lead
      await supabase
        .from('leads')
        .update({ 
          paypal_order_id: data.id,
          paypal_approval_url: data.links.find(l => l.rel === 'approve')?.href
        })
        .eq('id', leadId);

      return res.status(200).json({
        success: true,
        orderId: data.id,
        approvalUrl: data.links.find(l => l.rel === 'approve')?.href
      });
    }

  } catch (error) {
    console.error('PayPal error:', error);
    return res.status(500).json({ error: 'Failed to create payment' });
  }
}