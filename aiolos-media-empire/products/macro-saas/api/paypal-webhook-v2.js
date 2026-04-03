// PayPal Webhook Handler - Handle all PayPal events
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://irlxxeoocqktiuulfuqb.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpbXF1ZWxsZ2R0bW50eXJpZGp2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczOTE3MDk3MCwiZXhwIjoyMDU0NzQ2OTcwfQ.CkKe9CJUg-jLbUR-5A3rG64nbSws1OB7xTNS9NEi4I8'
);

// Verify PayPal webhook signature
function verifyWebhookSignature(body, headers) {
  const transmissionId = headers['paypal-transmission-id'];
  const certId = headers['paypal-cert-id'];
  const signature = headers['paypal-transmission-sig'];
  const timestamp = headers['paypal-transmission-time'];
  
  // Get webhook ID from environment
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  
  // Construct expected signature
  const expectedSig = `${transmissionId}|${timestamp}|${webhookId}|${crypto.createHash('sha256').update(body).digest('hex')}`;
  
  // In production, verify against PayPal's certificate
  // For now, check auth token as additional security
  return headers['x-webhook-auth'] === process.env.WEBHOOK_SECRET;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = JSON.stringify(req.body);
  
  // Verify webhook
  if (!verifyWebhookSignature(rawBody, req.headers)) {
    console.error('Webhook verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body;
  
  console.log('PayPal webhook received:', event.event_type);

  try {
    switch (event.event_type) {
      
      // Subscription activated (first payment)
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
      case 'BILLING.SUBSCRIPTION.PAYMENT.COMPLETED': {
        const subscription = event.resource;
        const subscriptionId = subscription.id;
        
        // Find lead by subscription ID
        const { data: lead } = await supabase
          .from('leads')
          .select('*')
          .eq('paypal_subscription_id', subscriptionId)
          .single();

        if (lead && lead.status !== 'paid') {
          // Activate user
          await activateUser(lead, subscriptionId);
        }
        break;
      }

      // Subscription cancelled
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED': {
        const subscription = event.resource;
        
        // Find and suspend user
        const { data: user } = await supabase
          .from('users')
          .select('*')
          .eq('paypal_subscription_id', subscription.id)
          .single();

        if (user) {
          await supabase
            .from('users')
            .update({ status: 'suspended', suspended_at: new Date().toISOString() })
            .eq('id', user.id);

          // Notify admin
          await notifyAdmin('Subscription Cancelled', user);
        }
        break;
      }

      // Payment failed
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
        const subscription = event.resource;
        
        const { data: user } = await supabase
          .from('users')
          .select('*')
          .eq('paypal_subscription_id', subscription.id)
          .single();

        if (user) {
          // Send payment failure email
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'MacroPWA <billing@aiolosmedia.com>',
              to: user.email,
              subject: 'Payment Failed - Please Update Your Payment Method',
              html: `
                <h2>Payment Failed</h2>
                <p>Hi ${user.name},</p>
                <p>We couldn't process your monthly payment for MacroPWA. Please update your payment method to keep your calculator active.</p>
                <p><a href="https://www.paypal.com/myaccount/settings/" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Update Payment Method →</a></p>
              `
            })
          });
        }
        break;
      }

      // Order completed (one-time payments)
      case 'CHECKOUT.ORDER.COMPLETED': {
        const order = event.resource;
        
        // Find lead by order ID
        const { data: lead } = await supabase
          .from('leads')
          .select('*')
          .eq('paypal_order_id', order.id)
          .single();

        if (lead && lead.status !== 'paid') {
          await activateUser(lead, null, order.id);
        }
        break;
      }

      // Refund processed
      case 'PAYMENT.CAPTURE.REFUNDED': {
        const refund = event.resource;
        // Handle refunds if needed
        console.log('Refund processed:', refund.id);
        break;
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

async function activateUser(lead, subscriptionId = null, orderId = null) {
  // Update lead status
  await supabase
    .from('leads')
    .update({ 
      status: 'paid',
      paid_at: new Date().toISOString()
    })
    .eq('id', lead.id);

  // Check if user already exists
  const { data: existingUser } = await supabase
    .from('users')
    .select('*')
    .eq('email', lead.email)
    .single();

  if (existingUser) {
    // Reactivate
    await supabase
      .from('users')
      .update({ status: 'active' })
      .eq('id', existingUser.id);
    return existingUser;
  }

  // Create new user
  const { data: user } = await supabase
    .from('users')
    .insert([{
      lead_id: lead.id,
      name: lead.name,
      email: lead.email,
      practice_name: lead.practice_name,
      selected_plan: lead.selected_plan,
      status: 'active',
      paypal_subscription_id: subscriptionId,
      paypal_order_id: orderId,
      dashboard_url: `https://dashboard.macropwa.app/u/${lead.id}`,
      created_at: new Date().toISOString()
    }])
    .select()
    .single();

  // Create calculator settings
  await supabase
    .from('calculator_settings')
    .insert([{
      user_id: user.id,
      primary_color: '#10b981',
      accent_color: '#f59e0b',
      capture_email: true
    }]);

  // Send welcome email
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'MacroPWA <hello@aiolosmedia.com>',
      to: lead.email,
      subject: 'Your MacroPWA Dashboard is Ready! 🎉',
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">Welcome to MacroPWA, ${lead.name}!</h2>
          <p>Your payment has been confirmed. Your dashboard is ready.</p>
          <a href="${user.dashboard_url}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 20px 0;">Access Dashboard →</a>
        </div>
      `
    })
  });

  // Notify admin
  await notifyAdmin('New Payment Received', { ...user, selected_plan: lead.selected_plan });

  return user;
}

async function notifyAdmin(subject, data) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'MacroPWA <notifications@aiolosmedia.com>',
      to: 'albert@aiolosmedia.com',
      subject: `💰 ${subject}`,
      html: `
        <h2>${subject}</h2>
        <p><strong>Customer:</strong> ${data.name}</p>
        <p><strong>Email:</strong> ${data.email}</p>
        <p><strong>Plan:</strong> ${data.selected_plan}</p>
        <p><strong>Dashboard:</strong> <a href="${data.dashboard_url}">${data.dashboard_url}</a></p>
      `
    })
  });
}