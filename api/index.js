const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function sendWhatsApp(payload) {
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('WhatsApp API Error:', err.response?.data || err.message);
  }
}

app.get('/', (req, res) => {
  res.send('🚗 DriveFlow Backend is LIVE on Vercel!');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const textBody = message.text?.body?.trim() || '';

    // ADMIN-ONLY: "ADD Rahul Menon 9876543210 12 5"
    if (from === process.env.ADMIN_PHONE && textBody.toUpperCase().startsWith('ADD ')) {
      const parts = textBody.split(/\s+/);
      const bikeBal = parseInt(parts.pop(), 10) || 5;
      const carBal = parseInt(parts.pop(), 10) || 12;
      let rawPhone = parts.pop().replace(/\D/g, '');
      if (rawPhone.length === 10) rawPhone = '91' + rawPhone;
      const studentName = parts.slice(1).join(' ');

      const { error } = await supabase
        .from('students')
        .insert([{ name: studentName, phone: rawPhone, car_balance: carBal, bike_balance: bikeBal }]);

      await sendWhatsApp({
        messaging_product: 'whatsapp',
        to: from,
        text: {
          body: error
            ? `❌ Error: ${error.message}`
            : `✅ *Student Added!*\nName: ${studentName}\nPhone: ${rawPhone}\nBalance: ${carBal} Car, ${bikeBal} Bike`,
        },
      });
      return res.sendStatus(200);
    }

    const { data: student } = await supabase
      .from('students')
      .select('*')
      .eq('phone', from)
      .single();

    if (!student) {
      await sendWhatsApp({
        messaging_product: 'whatsapp',
        to: from,
        text: { body: 'Sorry, your number is not registered. Contact Driving School Admin.' },
      });
      return res.sendStatus(200);
    }

    if (message.type === 'text') {
      await sendWhatsApp({
        messaging_product: 'whatsapp',
        to: from,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: `Hi *${student.name}*! 👋\n\n*Remaining Classes:*\n🚗 Car: ${student.car_balance}\n🏍️ Bike: ${student.bike_balance}\n\nChoose an option:`,
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'btn_book', title: '📅 Book a Class' } },
              { type: 'reply', reply: { id: 'btn_slots', title: '📋 My Bookings' } },
            ],
          },
        },
      });
    }

    if (message.type === 'interactive') {
      const buttonId = message.interactive.button_reply?.id;
      const listId = message.interactive.list_reply?.id;

      if (buttonId === 'btn_book') {
        const { data: slots } = await supabase
          .from('slots')
          .select('*')
          .eq('status', 'AVAILABLE')
          .order('id');

        if (!slots || slots.length === 0) {
          await sendWhatsApp({
            messaging_product: 'whatsapp',
            to: from,
            text: { body: 'No open slots right now. Check back later!' },
          });
          return res.sendStatus(200);
        }

        const rows = slots.map((s) => ({
          id: `book_${s.id}`,
          title: s.slot_name,
          description: `${s.slot_date} • ${s.time_range} (${s.vehicle})`,
        }));

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Available Slots' },
            body: { text: 'Tap below to pick your slot:' },
            action: {
              button: 'Select Slot',
              sections: [{ title: 'Open Slots', rows }],
            },
          },
        });
      }

      if (buttonId === 'btn_slots') {
        const { data: mySlots } = await supabase
          .from('slots')
          .select('*')
          .eq('booked_by_phone', from);

        const summary =
          mySlots && mySlots.length > 0
            ? mySlots.map((s) => `• *${s.slot_name}* (${s.slot_date}, ${s.time_range})`).join('\n')
            : 'You have no active bookings yet.';

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          text: { body: `📋 *Your Booked Classes:*\n\n${summary}` },
        });
      }

      if (listId && listId.startsWith('book_')) {
        const slotId = parseInt(listId.replace('book_', ''), 10);

        const { data: booked, error } = await supabase
          .from('slots')
          .update({ status: 'BOOKED', booked_by_phone: from })
          .eq('id', slotId)
          .eq('status', 'AVAILABLE')
          .select()
          .single();

        if (error || !booked) {
          await sendWhatsApp({
            messaging_product: 'whatsapp',
            to: from,
            text: { body: '⚠️ Slot no longer available. Type *Hi* to try again.' },
          });
          return res.sendStatus(200);
        }

        const field = booked.vehicle.toLowerCase().includes('car') ? 'car_balance' : 'bike_balance';
        await supabase
          .from('students')
          .update({ [field]: student[field] - 1 })
          .eq('phone', from);

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          text: {
            body: `✅ *Confirmed!*\n\n*Slot:* ${booked.slot_name}\n*Date:* ${booked.slot_date}\n*Time:* ${booked.time_range}\n*Vehicle:* ${booked.vehicle}`,
          },
        });
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook crash:', err);
    return res.sendStatus(200);
  }
});

app.get('/api/slots', async (req, res) => {
  const { data, error } = await supabase.from('slots').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = app;
