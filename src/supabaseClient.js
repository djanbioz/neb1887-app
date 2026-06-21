// ============================================================
// src/supabaseClient.js
// Paste your Supabase Project URL and anon key below.
// Get them from: Supabase Dashboard → Settings → API
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL  = 'https://qbrimzxabuyzgasfdsqs.supabase.co'
const SUPABASE_KEY  = 'sb_publishable_qXa3ql8_ezkmo4ve0WhtNQ_spqKAZJo'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)


// ── AUTH ─────────────────────────────────────────────────────

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null)
  })
}


// ── SETTINGS ─────────────────────────────────────────────────

export async function loadSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
  if (error) throw error
  // convert array of {key,value} to a plain object
  return Object.fromEntries(data.map(r => [r.key, r.value]))
}

export async function saveSettings(updates) {
  // updates = { daily_rate: '260', school_days: '22', ... }
  const rows = Object.entries(updates).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }))
  const { error } = await supabase
    .from('settings')
    .upsert(rows, { onConflict: 'key' })
  if (error) throw error
}


// ── STUDENTS ─────────────────────────────────────────────────

export async function loadStudents() {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('active', true)
    .order('name')
  if (error) throw error
  return data
}

export async function addStudent(student) {
  const { data, error } = await supabase
    .from('students')
    .insert([student])
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateStudent(id, updates) {
  const { error } = await supabase
    .from('students')
    .update(updates)
    .eq('id', id)
  if (error) throw error
}

export async function deactivateStudent(id) {
  const { error } = await supabase
    .from('students')
    .update({ active: false })
    .eq('id', id)
  if (error) throw error
}


// ── TRANSACTIONS ─────────────────────────────────────────────

export async function loadTransactions({ period, studentId, method, limit = 200 } = {}) {
  let query = supabase
    .from('transactions')
    .select('*, students(name, grade, guardian)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (period)    query = query.eq('period', period)
  if (studentId) query = query.eq('student_id', studentId)
  if (method)    query = query.eq('method', method)

  const { data, error } = await query
  if (error) throw error
  return data
}

export async function addTransaction(txn) {
  // txn = { id, student_id, amount, method, date, period, ref, status, note }
  const { data, error } = await supabase
    .from('transactions')
    .insert([txn])
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateTransaction(id, updates) {
  const { error } = await supabase
    .from('transactions')
    .update(updates)
    .eq('id', id)
  if (error) throw error
}

export async function cancelTransaction(id) {
  return updateTransaction(id, { status: 'cancelled' })
}


// ── EXPENSES ─────────────────────────────────────────────────

export async function loadExpenses(period) {
  let query = supabase
    .from('expenses')
    .select('*')
    .order('date', { ascending: false })
  if (period) query = query.eq('period', period)

  const { data, error } = await query
  if (error) throw error
  return data
}

export async function addExpense(expense) {
  const { data, error } = await supabase
    .from('expenses')
    .insert([expense])
    .select()
    .single()
  if (error) throw error
  return data
}


// ── REPORTS / VIEWS ──────────────────────────────────────────

export async function loadMonthlySummary() {
  const { data, error } = await supabase
    .from('monthly_summary')
    .select('*')
  if (error) throw error
  return data
}

export async function loadStudentBalances(period) {
  let query = supabase
    .from('student_balances')
    .select('*')
  if (period) query = query.eq('period', period)

  const { data, error } = await query
  if (error) throw error
  return data
}


// ── REALTIME ─────────────────────────────────────────────────
// Call this to get live updates when a new transaction is added
// from another device.
//
// Usage:
//   const unsub = subscribeToTransactions(newTxn => {
//     setTxns(prev => [newTxn, ...prev])
//   })
//   // later: unsub()
//
export function subscribeToTransactions(callback) {
  const channel = supabase
    .channel('transactions-changes')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'transactions' },
      payload => callback(payload.new)
    )
    .subscribe()

  return () => supabase.removeChannel(channel)
}
