// PayPal Webhook - Handle payment confirmation
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Verify PayPal webhook signature (simplified - use proper verification in production)
function verifyWebhook(body, headers) {
  // TODO: Implement PayPal webhook signature verification
  // For now, check auth token
  return headers['x-webhook-auth'] === process.env.WEBHOOK_SECRET;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify webhook
  if (!verifyWebhook(req.body, req.headers)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body;

  try {
    // Handle successful payment
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const { payer } = event.resource;
      const email = payer.email_address;
      
      // Find lead by email
      const { data: lead } = await supabase
        .from('leads')
        .select('*')
        .eq('email', email)
        .eq('status', 'pending_payment')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (lead) {
        // Update lead status
        await supabase
          .from('leads')
          .update({ status: 'paid', paid_at: new Date().toISOString() })
          .eq('id', lead.id);

        // Create user account
        const { data: user } = await supabase
          .from('users')
          .insert([{
            lead_id: lead.id,
            name: lead.name,
            email: lead.email,
            practice_name: lead.practice_name,
            selected_plan: lead.selected_plan,
            status: 'active',
            dashboard_url: `https://dashboard.macropwa.app/${lead.id}`,
            created_at: new Date().toISOString()
          }])
          .select()
          .single();

        // Send dashboard access email
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'MacroPWA <hello@aiolosmedia.com>',
            to: lead.email,
            subject: 'Your MacroPWA Dashboard is Ready!',
            html: `
              <h2>Welcome to MacroPWA, ${lead.name}!</h2>
              <p>Your payment has been confirmed. Your dashboard is ready:</p>
              <p><a href="${user.dashboard_url}" style="background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;margin:10px 0;">Access Dashboard →</a></p>
              <p>From your dashboard you can:</p>
              <ul>
                <li>Customize your calculator branding</li>
                <li>Set your macro calculation preferences</li>
                <li>Get your embed code</li>
                <li>View captured leads</li>
              </ul>
              <hr>
              <p>Need help? Reply to this email.</p>
            `
          })
        });

        return res.status(200).json({ success: true });
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}