// Vercel Serverless Function - Submit Lead
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://irlxxeoocqktiuulfuqb.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpbXF1ZWxsZ2R0bW50eXJpZGp2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczOTE3MDk3MCwiZXhwIjoyMDU0NzQ2OTcwfQ.CkKe9CJUg-jLbUR-5A3rG64nbSws1OB7xTNS9NEi4I8'
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, practice, website, plan, notes } = req.body;

  // Validate required fields
  if (!name || !email || !plan) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. Save lead to Supabase
    const { data: lead, error } = await supabase
      .from('leads')
      .insert([{
        name,
        email,
        practice_name: practice,
        website,
        selected_plan: plan,
        notes,
        status: 'pending_payment',
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    // 2. Send notification email to you (Albert)
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MacroPWA <notifications@aiolosmedia.com>',
        to: 'albert@aiolosmedia.com',
        subject: `New Lead: ${name} - ${plan}`,
        html: `
          <h2>New MacroPWA Lead</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Practice:</strong> ${practice || 'N/A'}</p>
          <p><strong>Plan:</strong> ${plan}</p>
          <p><strong>Website:</strong> ${website || 'N/A'}</p>
          <p><strong>Notes:</strong> ${notes || 'N/A'}</p>
          <p><strong>Lead ID:</strong> ${lead.id}</p>
          <hr>
          <p>Next step: Send PayPal payment link for ${plan}</p>
        `
      })
    });

    // 3. Send welcome email to lead with payment instructions
    const planPrices = {
      'saas': { price: '$49/mo', link: process.env.PAYPAL_SAAS_LINK },
      'done-for-you': { price: '$297', link: process.env.PAYPAL_DFY_LINK },
      'premium': { price: '$497', link: process.env.PAYPAL_PREMIUM_LINK }
    };

    const planInfo = planPrices[plan] || planPrices['saas'];

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MacroPWA <hello@aiolosmedia.com>',
        to: email,
        subject: 'Your MacroPWA Calculator is Ready to Activate',
        html: `
          <h2>Hi ${name},</h2>
          <p>Thanks for your interest in MacroPWA!</p>
          <p>You selected: <strong>${plan}</strong> (${planInfo.price})</p>
          <p>To activate your branded calculator, complete your payment here:</p>
          <p><a href="${planInfo.link}" style="background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;margin:10px 0;">Complete Payment →</a></p>
          <p>Once payment is confirmed, you'll receive your dashboard access within 24 hours.</p>
          <hr>
          <p>Questions? Reply to this email.</p>
          <p>— The MacroPWA Team</p>
        `
      })
    });

    return res.status(200).json({ 
      success: true, 
      leadId: lead.id,
      message: 'Lead captured. Check your email for next steps.'
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to process lead' });
  }
}