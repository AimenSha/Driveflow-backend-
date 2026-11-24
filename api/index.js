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

const VEHICLES = [
  { code: 'ALTO_ROAD', label: 'Car Road (Alto 800)', type: 'car' },
  { code: 'CAR_H', label: 'Car (H)', type: 'car' },
  { code: 'SPLENDOR', label: 'Splendor (Gear)', type: 'bike' },
  { code: 'SPLENDOR_8', label: 'Splendor (8 Track)', type: 'bike' },
  { code: 'TVS_XL', label: 'TVS XL 1 (No Gear)', type: 'bike' },
  { code: 'TVS_XL_8', label: 'TVS XL 1 (8 Track)', type: 'bike' },
];

function buildHalfHourRanges(startMin, endMin) {
  const list = [];
  for (let m = startMin; m < endMin; m += 30) {
    const fmt = (mins) => {
      const h24 = Math.floor(mins / 60);
      const mm = String(mins % 60).padStart(2, '0');
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return `${String(h12).padStart(2, '0')}:${mm} ${ampm}`;
    };
    const session = m < 720 ? 'MORNING' : m < 1020 ? 'AFTERNOON' : 'EVENING';
    list.push({ time_range: `${fmt(m)} - ${fmt(m + 30)}`, session_part: session });
  }
  return list;
}

const ALTO_RANGES = buildHalfHourRanges(5 * 60 + 30, 10 * 60 + 30);
const CAR_H_RANGES = buildHalfHourRanges(15 * 60, 19 * 60);
const BIKE_RANGES = [
  ...buildHalfHourRanges(6 * 60 + 30, 9 * 60),
  ...buildHalfHourRanges(10 * 60, 13 * 60),
  ...buildHalfHourRanges(14 * 60, 18 * 60 + 30)
];

function getISTDateString(offsetDays = 0) {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000 + offsetDays * 86400000;
  return new Date(istMs).toISOString().slice(0, 10);
}

async function ensureUpcomingSlots(daysAhead = 7) {
  const rowsToInsert = [];
  for (let d = 0; d < daysAhead; d++) {
    const dateStr = getISTDateString(d);
    const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
    if (dayOfWeek === 0) continue;

    for (const v of VEHICLES) {
      const isCar = v.code === 'ALTO_ROAD' || v.code === 'CAR_H';
      if (dayOfWeek === 4 && isCar) continue;

      const ranges =
        v.code === 'ALTO_ROAD' ? ALTO_RANGES : v.code === 'CAR_H' ? CAR_H_RANGES : BIKE_RANGES;

      for (const r of ranges) {
        rowsToInsert.push({
          slot_date: dateStr,
          time_range: r.time_range,
          vehicle_code: v.code,
          vehicle_label: v.label,
          session_part: r.session_part,
          status: 'AVAILABLE',
        });
      }
    }
  }
  if (rowsToInsert.length > 0) {
    await supabase
      .from('slots')
      .upsert(rowsToInsert, { onConflict: 'slot_date,time_range,vehicle_code', ignoreDuplicates: true });
  }
}

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

function checkPin(req, res) {
  const pin = req.headers['x-admin-pin'] || req.query.pin || req.body?.pin;
  const expected = process.env.ADMIN_PIN || '1234';
  if (String(pin) !== String(expected)) {
    res.status(401).json({ error: 'Invalid Admin PIN' });
    return false;
  }
  return true;
}

app.get('/api/admin/overview', async (req, res) => {
  if (!checkPin(req, res)) return;
  await ensureUpcomingSlots(7);
  const date = req.query.date || getISTDateString(0);

  const [{ data: students }, { data: slots }] = await Promise.all([
    supabase.from('students').select('*').order('id', { ascending: false }),
    supabase.from('slots').select('*').eq('slot_date', date).order('id'),
  ]);
  res.json({ date, students: students || [], slots: slots || [] });
});

app.post('/api/admin/students', async (req, res) => {
  if (!checkPin(req, res)) return;
  const { name, phone, package_type, paid_amount, pickup_landmark } = req.body;
  let cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
  if (!name || cleanPhone.length < 12) {
    return res.status(400).json({ error: 'Valid name and 10-digit phone required' });
  }

  const paid = parseInt(paid_amount, 10) || 0;
  let total_fee = 11000;
  let car_balance = 30;
  let bike_balance = 1;
  let full_cash_bonus = false;

  if (package_type === 'CAR_ONLY') {
    total_fee = 8000;
    car_balance = 30;
    bike_balance = 0;
  } else if (package_type === 'BIKE_ONLY') {
    total_fee = 3000;
    car_balance = 0;
    bike_balance = 1;
  } else {
    total_fee = 11000;
    if (paid >= 11000) {
      bike_balance = 5;
      full_cash_bonus = true;
    }
  }

  const { data, error } = await supabase
    .from('students')
    .upsert(
      [
        {
          name: name.trim(),
          phone: cleanPhone,
          package_type: package_type || 'COMBO',
          total_fee,
          paid_amount: paid,
          car_balance,
          bike_balance,
          full_cash_bonus,
          pickup_landmark: pickup_landmark || '',
        },
      ],
      { onConflict: 'phone' }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ student: data });
});

app.post('/api/admin/payment', async (req, res) => {
  if (!checkPin(req, res)) return;
  const { phone, add_amount } = req.body;
  const extra = parseInt(add_amount, 10) || 0;

  const { data: st, error: findErr } = await supabase
    .from('students')
    .select('*')
    .eq('phone', phone)
    .single();
  if (findErr || !st) return res.status(404).json({ error: 'Student not found' });

  const newPaid = (st.paid_amount || 0) + extra;
  let newBike = st.bike_balance;
  let bonus = st.full_cash_bonus;

  if (st.package_type === 'COMBO' && !bonus && newPaid >= st.total_fee) {
    newBike += 4;
    bonus = true;
  }

  const { data, error } = await supabase
    .from('students')
    .update({ paid_amount: newPaid, bike_balance: newBike, full_cash_bonus: bonus })
    .eq('phone', phone)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ student: data });
});

app.post('/api/admin/toggle-day', async (req, res) => {
  if (!checkPin(req, res)) return;
  const { date, vehicle_code, status } = req.body;
  let q = supabase.from('slots').select('*').eq('slot_date', date);
  if (vehicle_code && vehicle_code !== 'ALL') q = q.eq('vehicle_code', vehicle_code);
  const { data: targetSlots } = await q;

  let upd = supabase.from('slots').update({ status }).eq('slot_date', date);
  if (vehicle_code && vehicle_code !== 'ALL') upd = upd.eq('vehicle_code', vehicle_code);
  await upd;

  if (status === 'CANCELLED' && targetSlots) {
    for (const s of targetSlots) {
      if (s.booked_by_phone) {
        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: s.booked_by_phone,
          text: {
            body: `⚠️ *Class Cancelled*\nYour *${s.vehicle_label}* class on *${s.slot_date}* (${s.time_range}) was cancelled due to holiday/maintenance. Your class credit remains safe—type *Hi* to book another slot.`,
          },
        });
      }
    }
  }
  res.json({ ok: true });
});
app.get('/', (req, res) => {
  res.send('🚗 DriveFlow Backend is LIVE! Open /admin for Driving School Dashboard.');
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

    const isTutor = process.env.TUTOR_PHONE && from === process.env.TUTOR_PHONE;
    const hasLocation =
      message.type === 'location' ||
      (message.type === 'text' && /maps\.app\.goo\.gl|google\.com\/maps/i.test(textBody));

    if (isTutor && hasLocation) {
      const today = getISTDateString(0);
      const { data: roadBookings } = await supabase
        .from('slots')
        .select('*')
        .eq('slot_date', today)
        .eq('vehicle_code', 'ALTO_ROAD')
        .eq('status', 'BOOKED')
        .order('id');

      if (!roadBookings || roadBookings.length === 0) {
        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          text: { body: '📍 Location received, but there are no booked Alto 800 road students today.' },
        });
        return res.sendStatus(200);
      }

      const uniquePhones = [...new Set(roadBookings.map((b) => b.booked_by_phone).filter(Boolean))];
      for (const studentPhone of uniquePhones) {
        const mySlot = roadBookings.find((b) => b.booked_by_phone === studentPhone);
        if (message.type === 'location') {
          await sendWhatsApp({
            messaging_product: 'whatsapp',
            to: studentPhone,
            type: 'location',
            location: {
              latitude: message.location.latitude,
              longitude: message.location.longitude,
              name: 'Alto 800 Tutor Live Location',
              address: `Your road slot: ${mySlot.time_range}`,
            },
          });
        } else {
          await sendWhatsApp({
            messaging_product: 'whatsapp',
            to: studentPhone,
            text: {
              body: `🚗 *Alto 800 Tutor is on the way!*\nYour road slot: *${mySlot.time_range}*\n\nTrack live location here so you can be at your pickup point on time:\n${textBody}`,
            },
          });
        }
      }

      await sendWhatsApp({
        messaging_product: 'whatsapp',
        to: from,
        text: { body: `✅ Tutor location shared with ${uniquePhones.length} Alto 800 student(s) for today.` },
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
              { type: 'reply', reply: { id: 'btn_fees', title: '💰 Fee Status' } },
            ],
          },
        },
      });
      return res.sendStatus(200);
    }

    if (message.type === 'interactive') {
      const buttonId = message.interactive.button_reply?.id;
      const listId = message.interactive.list_reply?.id;

      if (buttonId === 'btn_fees') {
        const pending = Math.max(0, (student.total_fee || 0) - (student.paid_amount || 0));
        const bonusNote = student.full_cash_bonus ? '\n🎁 *Full-Cash Bonus:* +4 Bike classes unlocked!' : '';
        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          text: {
            body: `💰 *Your Fee Status*\n\n*Package:* ${student.package_type}\n*Total Fee:* ₹${student.total_fee}\n*Paid:* ₹${student.paid_amount}\n*Pending Balance:* ₹${pending}${bonusNote}\n\n*Classes Left:* ${student.car_balance} Car, ${student.bike_balance} Bike`,
          },
        });
        return res.sendStatus(200);
      }

      if (buttonId === 'btn_slots') {
        const today = getISTDateString(0);
        const { data: mySlots } = await supabase
          .from('slots')
          .select('*')
          .eq('booked_by_phone', from)
          .gte('slot_date', today)
          .order('slot_date')
          .order('id');

        const summary =
          mySlots && mySlots.length > 0
            ? mySlots.map((s) => `• *${s.vehicle_label}*\n  ${s.slot_date} • ${s.time_range}`).join('\n')
            : 'You have no upcoming bookings yet.';

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          text: { body: `📋 *Your Upcoming Classes:*\n\n${summary}` },
        });
        return res.sendStatus(200);
      }

      if (buttonId === 'btn_book') {
        await ensureUpcomingSlots(7);
        const rows = VEHICLES.map((v) => ({
          id: `veh_${v.code}`,
          title: v.label,
          description: v.type === 'car' ? `Car Balance: ${student.car_balance}` : `Bike Balance: ${student.bike_balance}`,
        }));

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Step 1: Choose Vehicle' },
            body: { text: 'Select your training vehicle/track:' },
            action: { button: 'Select Vehicle', sections: [{ title: 'Training Tracks', rows }] },
          },
        });
        return res.sendStatus(200);
      }

      if (listId && listId.startsWith('veh_')) {
        const vehCode = listId.replace('veh_', '');
        const today = getISTDateString(0);
        const tomorrow = getISTDateString(1);

        const { data: openSlots } = await supabase
          .from('slots')
          .select('slot_date, session_part')
          .eq('vehicle_code', vehCode)
          .eq('status', 'AVAILABLE')
          .in('slot_date', [today, tomorrow]);

        if (!openSlots || openSlots.length === 0) {
          await sendWhatsApp({
            messaging_product: 'whatsapp',
            to: from,
            text: { body: 'No open slots for today or tomorrow (note: Sunday is holiday & Thursday has no Car classes).' },
          });
          return res.sendStatus(200);
        }

        const combos = [...new Set(openSlots.map((s) => `${s.slot_date}|${s.session_part}`))].slice(0, 10);
        const rows = combos.map((c) => {
          const [d, sess] = c.split('|');
          const dayLabel = d === today ? 'Today' : 'Tomorrow';
          return {
            id: `ses_${vehCode}_${d}_${sess}`,
            title: `${dayLabel} • ${sess}`,
            description: `${d} (${sess.toLowerCase()} slots)`,
          };
        });

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Step 2: Choose Session' },
            body: { text: 'Pick Today or Tomorrow and session time:' },
            action: { button: 'Select Session', sections: [{ title: 'Available Sessions', rows }] },
          },
        });
        return res.sendStatus(200);
      }

      if (listId && listId.startsWith('ses_')) {
        const parts = listId.split('_');
        const sess = parts.pop();
        const dateStr = parts.pop();
        const vehCode = parts.slice(1).join('_');

        const { data: slots } = await supabase
          .from('slots')
          .select('*')
          .eq('vehicle_code', vehCode)
          .eq('slot_date', dateStr)
          .eq('session_part', sess)
          .eq('status', 'AVAILABLE')
          .order('id')
          .limit(10);

        if (!slots || slots.length === 0) {
          await sendWhatsApp({
            messaging_product: 'whatsapp',
            to: from,
            text: { body: 'Those slots just filled up! Type *Hi* to pick another session.' },
          });
          return res.sendStatus(200);
        }

        const rows = slots.map((s) => ({
          id: `book_${s.id}`,
          title: s.time_range,
          description: `${s.vehicle_label} • ${s.slot_date}`,
        }));

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Step 3: Pick 30-Min Slot' },
            body: { text: `Available ${sess.toLowerCase()} slots on ${dateStr}:` },
            action: { button: 'Pick Time', sections: [{ title: '30-Min Slots', rows }] },
          },
        });
        return res.sendStatus(200);
      }

      if (listId && listId.startsWith('book_')) {
        const slotId = parseInt(listId.replace('book_', ''), 10);
        const { data: target } = await supabase.from('slots').select('*').eq('id', slotId).single();
        if (!target) return res.sendStatus(200);

        const isCar = target.vehicle_code === 'ALTO_ROAD' || target.vehicle_code === 'CAR_H';
        const balanceField = isCar ? 'car_balance' : 'bike_balance';

        if ((student[balanceField] || 0) <= 0) {
          await sendWhatsApp({
            messaging_product: 'whatsapp',
            to: from,
            text: { body: `⚠️ You have *0 ${isCar ? 'Car' : 'Bike'} classes* remaining. Contact Driving School Admin.` },
          });
          return res.sendStatus(200);
        }

        const { data: booked, error } = await supabase
          .from('slots')
          .update({
            status: 'BOOKED',
            booked_by_phone: from,
            booked_by_name: student.name,
            pickup_landmark: student.pickup_landmark || '',
          })
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

        await supabase
          .from('students')
          .update({ [balanceField]: student[balanceField] - 1 })
          .eq('phone', from);

        const roadNote =
          booked.vehicle_code === 'ALTO_ROAD'
            ? '\n📍 *Note:* Tutor will share live location on WhatsApp when the morning road route begins.'
            : '';

        await sendWhatsApp({
          messaging_product: 'whatsapp',
          to: from,
          text: {
            body: `✅ *Booking Confirmed!*\n\n*Vehicle:* ${booked.vehicle_label}\n*Date:* ${booked.slot_date}\n*Time:* ${booked.time_range}${roadNote}`,
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

module.exports = app;
