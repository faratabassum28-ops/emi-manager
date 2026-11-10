import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import App from './App';
import { AuthProvider } from './auth';
import { setToken } from './api';

const ev = (id, label, extra = {}) => ({ id, at: '2026-11-10T04:30:00Z', by: 'Asha', label, detail: '', reason: '', tone: '', kind: 'payment', entity: 'Payment', student: 'Meera Nair', batch: 'SUPER-B07', enrollment_id: 'e1', ...extra });
const enrollment = {
  student: { full_name: 'Meera Nair', phone: '+919876543210', email: 'm@x.com' }, batch: { id: 'b1', code: 'SUPER-B07', name: 'Batch 7', status: 'Running' }, program: { id: 'p1', name: 'SUPER', max_emis: 12 },
  enrollment: { id: 'e1', enrollment_date: '2026-10-01', total_fee: 250000, adjustments: [], discount: 0, application_fee_paid: 10000, commitment_fee_paid: 40000, net_payable: 250000, balance_due: 200000, emi_count: 6, plan_history: [] },
  status: 'Overdue', bucket: 'overdue', paid: 50000, balance: 200000, emis_paid: 0, emi_total: 6,
  instalments: [{ id: 'i1', type: 'EMI', emi_number: 1, amount_due: 33333, amount_paid: 0, balance: 33333, due_date: '2026-11-01', status: 'Overdue', days_overdue: 9 }],
  payments: [], reminders: [], others: [], discount_limit: 10000,
};
const routes = {
  '/auth/me': { user: { name: 'Nitin', role: 'Admin', can_verify: true } },
  '/nav': [{ _id: 'p1', name: 'SUPER', batches: [{ _id: 'b1', batch_name: 'Batch 7' }] }],
  '/pulse': { today: '2026-11-10', overdue: 4, due_today: 2, promised_today: 1, unverified: 3 },
  '/home': { today: '2026-11-10', totals: { collected_this_month: 100000, due_this_month: 200000, overdue_amount: 33333, overdue_count: 1, collection_rate: 50, students: 7 }, batches: [], today_list: [{ instalment_id: 'i1', enrollment_id: 'e1', student_name: 'Meera Nair', program: 'SUPER', batch_name: 'Batch 7', emi_number: 1, emi_total: 6, balance: 33333 }] },
  '/insights': { window: { start: '2026-11-01', end: '2026-11-10', days: 10, partial: true }, previous: null, unit: 'day', series: [{ key: '2026-11-05', collected: 30500 }], current: { collected: 30500, payments: 1, avg_payment: 30500, reversed: 0, new_enrollments: 2, enrolled_value: 500000, followups: 5, calls: 3, promises: 1, by_mode: [{ mode: 'UPI', amount: 30500 }] }, prior: { collected: 15250, payments: 1, avg_payment: 15250, new_enrollments: 2, followups: 10 } },
  '/activity': { total: 2, page: 1, limit: 50, users: ['Asha'], entities: ['Payment'], items: [ev('a1', 'Payment of ₹30,500 recorded', { detail: 'UPI · Ref UTR1', tone: 'good' }), ev('a2', 'Payment of ₹100 reversed', { tone: 'bad', reason: 'Wrong student' })] },
  '/enrollments/e1/history': { events: [ev('a1', 'Payment of ₹30,500 recorded', { tone: 'good' }), ev('r1', 'Call: Will pay on date', { kind: 'reminder', tone: 'warn', detail: 'promised 15 Nov 2026' })] },
  '/enrollments/e1': enrollment,
  '/tracker': { today: '2026-11-10', total: 1, total_balance: 33333, rows: [{ instalment_id: 'i1', enrollment_id: 'e1', batch_id: 'b1', batch_name: 'Batch 7', program: 'SUPER', student_name: 'Meera Nair', phone: '+919876543210', emi_number: 1, emi_total: 6, amount_due: 33333, amount_paid: 0, balance: 33333, due_date: '2026-11-01', days_overdue: 9, status: 'Overdue', last_reminder: null, promised_date: null, assigned: 'Ravi' }] },
};
beforeEach(() => {
  cleanup(); localStorage.clear(); setToken('t');
  global.fetch = vi.fn(async (url) => {
    const path = String(url).replace('/api', '').split('?')[0];
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({ error: `no mock for ${path}` }) };
    return { ok: true, status: 200, json: async () => routes[path] };
  });
});
const mount = (at) => render(<MemoryRouter initialEntries={[at]}><AuthProvider><App /></AuthProvider></MemoryRouter>);

describe('new screens render with real data', () => {
  it('sidebar shows live badges', async () => {
    mount('/');
    await waitFor(() => expect(screen.getByText('4')).toBeTruthy()); // overdue badge on tracker
    expect(screen.getByText('3')).toBeTruthy();                       // unverified badge
    expect(screen.getByText(/1 promised to pay today/)).toBeTruthy();
  });
  it('home compares the period with the one before', async () => {
    mount('/');
    await waitFor(() => expect(screen.getByText('In this period', { exact: false })).toBeTruthy());
    expect(screen.getByText('▲ 100%')).toBeTruthy();          // collected doubled
    expect(screen.getAllByText('Latest activity').length).toBe(1);
    expect(screen.getByText('Payment of ₹30,500 recorded')).toBeTruthy();
  });
  it('home due-today row opens the student drawer with history', async () => {
    mount('/');
    const rows = await screen.findAllByText('Meera Nair');
    fireEvent.click(rows.find((n) => n.tagName === 'B')); // the due-today row, not the feed link
    await waitFor(() => expect(screen.getByText('Call: Will pay on date')).toBeTruthy());
    expect(screen.getByText('Open full profile →')).toBeTruthy();
  });
  it('activity page lists, filters and shows reasons', async () => {
    mount('/activity');
    await waitFor(() => expect(screen.getByText('Payment of ₹100 reversed')).toBeTruthy());
    expect(screen.getByText('“Wrong student”')).toBeTruthy();
    fireEvent.click(screen.getByText('Table'));
    await waitFor(() => expect(screen.getAllByText('Payment of ₹30,500 recorded').length).toBeGreaterThan(0));
    expect(screen.getByText('Download CSV')).toBeTruthy();
  });
  it('profile has a History tab', async () => {
    mount('/enrollments/e1');
    const tab = await screen.findByRole('tab', { name: 'History' });
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getByText('Call: Will pay on date')).toBeTruthy());
    expect(screen.getByText('Follow-ups (1)')).toBeTruthy();
  });
  it('tracker name opens quick view', async () => {
    mount('/tracker');
    fireEvent.click(await screen.findByTitle('Quick view and history'));
    await waitFor(() => expect(screen.getByText('Schedule')).toBeTruthy());
  });
});
