// Capture PayPal payment after user approves
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

  const { leadId, orderId, subscriptionId } = req.body;

  try {
    const token = await getPayPalToken();

    // Get lead details
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    let paymentData;

    if (subscriptionId) {
      // Verify subscription
      const response = await fetch(`${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      paymentData = await response.json();
      
      if (paymentData.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Subscription not active' });
      }

    } else if (orderId) {
      // Capture one-time payment
      const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      paymentData = await response.json();
      
      if (paymentData.status !== 'COMPLETED') {
        return res.status(400).json({ error: 'Payment not completed' });
      }
    }

    // Update lead status
    await supabase
      .from('leads')
      .update({ 
        status: 'paid',
        paid_at: new Date().toISOString(),
        payment_data: paymentData
      })
      .eq('id', leadId);

    // Create user account
    const { data: user } = await supabase
      .from('users')
      .insert([{
        lead_id: leadId,
        name: lead.name,
        email: lead.email,
        practice_name: lead.practice_name,
        selected_plan: lead.selected_plan,
        status: 'active',
        paypal_subscription_id: subscriptionId || null,
        paypal_order_id: orderId || null,
        dashboard_url: `https://dashboard.macropwa.app/u/${leadId}`,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    // Create default calculator settings
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
            
            <p>Your payment has been confirmed. Your branded macro calculator dashboard is ready.</p>
            
            <div style="background: #f0fdf4; padding: 20px; border-radius: 12px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Your Dashboard</h3>
              <a href="${user.dashboard_url}" 
                 style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
                Access Dashboard →
              </a>
            </div>
            
            <h3>What you can do:</h3>
            <ul>
              <li>Upload your logo and set brand colors</li>
              <li>Customize macro calculation options</li>
              <li>Get embed code for your website</li>
              <li>View leads captured from your calculator</li>
            </ul>
            
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
            
            <p style="color: #6b7280; font-size: 14px;">
              Questions? Reply to this email or contact hello@aiolosmedia.com
            </p>
          </div>
        `
      })
    });

    // Notify admin
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MacroPWA <notifications@aiolosmedia.com>',
        to: 'albert@aiolosmedia.com',
        subject: `💰 New Payment: ${lead.name} - ${lead.selected_plan}`,
        html: `
          <h2>New Payment Received!</h2>
          <p><strong>Customer:</strong> ${lead.name}</p>
          <p><strong>Email:</strong> ${lead.email}</p>
          <p><strong>Plan:</strong> ${lead.selected_plan}</p>
          <p><strong>Amount:</strong> ${subscriptionId ? '$49/month' : (lead.selected_plan === 'premium' ? '$497' : '$297')}</p>
          <p><strong>Dashboard:</strong> <a href="${user.dashboard_url}">${user.dashboard_url}</a></p>
          <hr>
          <p>Subscription ID: ${subscriptionId || 'N/A'}</p>
          <p>Order ID: ${orderId || 'N/A'}</p>
        `
      })
    });

    return res.status(200).json({
      success: true,
      userId: user.id,
      dashboardUrl: user.dashboard_url
    });

  } catch (error) {
    console.error('Capture error:', error);
    return res.status(500).json({ error: 'Failed to capture payment' });
  }
}