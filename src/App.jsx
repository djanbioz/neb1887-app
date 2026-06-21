// ============================================================
// src/App.jsx  —  NEB 1887 School Bus Management App
// Full Supabase-wired version
// ============================================================

import { useState, useEffect, useRef } from 'react'
import {
  supabase,
  signIn, signOut, onAuthChange, loadUserRole,
  loadSettings, saveSettings,
  loadStudents, addStudent, updateStudent, deactivateStudent, reactivateStudent, permanentlyDeleteStudent,
  loadTransactions, addTransaction,
  loadExpenses, addExpense,
  loadMonthlySummary,
  loadAttendance, setAttendance,
  subscribeToTransactions,
} from './supabaseClient'
import { exportTransactionsPDF, exportExpensesPDF } from './pdfReports'

// ─── DESIGN TOKENS ───────────────────────────────────────────
const C = {
  gcash:'#007DFF', gcashDk:'#005DC2', gcashLt:'#E8F2FF',
  navy:'#0D1B3E',  navyMd:'#1A2F5A',
  amber:'#F0A500', amberLt:'#FFC84A',
  cream:'#F5F6FA', white:'#FFFFFF',
  green:'#1BA94C', greenLt:'#E6F7ED',
  red:'#D93025',   redLt:'#FDECEA',
  yellow:'#FFF3CD',yellowDk:'#856404',
  border:'#E2E6F0',muted:'#6B7A99', text:'#1A2F5A',
}

// ─── HELPERS ─────────────────────────────────────────────────
const peso    = n  => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits:0, maximumFractionDigits:0 })
const uid     = () => 'TXN-' + Math.random().toString(36).slice(2,8).toUpperCase()
const refid   = m  => m === 'GCash' ? 'GC-' + Math.floor(Math.random()*9000000+1000000) : 'CASH-' + Math.floor(Math.random()*900+100)
const fmtDate = d  => new Date(d).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' })
const fmtShort= d  => new Date(d).toLocaleDateString('en-PH', { month:'short', day:'numeric' })
const today   = () => new Date().toISOString().slice(0,10)
const pad2    = n  => String(n).padStart(2,'0')
const isoDate = d  => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`

// ── WEEKLY PERIOD SYSTEM (Mon–Fri) ────────────────────────────
// Generates every school week from a start date to an end date.
// Each week is { key, label, monthLabel, monday, friday, weekOfMonth }
// key format:   "2026-W23"      (ISO-ish, stable for sorting/storage)
// label format: "Week 1 — Jun 2026"
// A week is billed/grouped under the MONTH OF ITS MONDAY — this keeps
// grouping unambiguous even when a week's Friday spills into the next month.
function generateWeeks(startDate, endDate) {
  const weeks = []
  // Find the first Monday on/after startDate
  let cursor = new Date(startDate)
  const day = cursor.getDay() // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 1 : (day === 1 ? 0 : 8 - day)
  cursor.setDate(cursor.getDate() + diffToMonday)

  // Track week-of-month counters per "YYYY-MM" bucket (keyed by Monday's month)
  const monthCounters = {}

  while (cursor <= endDate) {
    const monday  = new Date(cursor)
    const friday  = new Date(cursor)
    friday.setDate(friday.getDate() + 4)

    const monthKey   = `${monday.getFullYear()}-${pad2(monday.getMonth()+1)}`
    monthCounters[monthKey] = (monthCounters[monthKey] || 0) + 1
    const weekOfMonth = monthCounters[monthKey]

    const monthLabel = monday.toLocaleDateString('en-PH', { month:'short', year:'numeric' })
    const key   = `${monday.getFullYear()}-W${pad2(weekOfMonth)}-${pad2(monday.getMonth()+1)}`
    const label = `Week ${weekOfMonth} — ${monthLabel}`
    const dateRange = monday.getMonth() === friday.getMonth()
      ? `${monday.toLocaleDateString('en-PH',{month:'short',day:'numeric'})}–${friday.getDate()}, ${friday.getFullYear()}`
      : `${fmtShort(monday)} – ${fmtShort(friday)}, ${friday.getFullYear()}`

    weeks.push({
      key, label, monthKey, monthLabel, weekOfMonth,
      monday: isoDate(monday), friday: isoDate(friday),
      dateRange,
    })

    cursor.setDate(cursor.getDate() + 7)
  }
  return weeks
}

const WEEKS = generateWeeks(new Date(2026, 5, 1), new Date(2027, 3, 30)) // Jun 2026 – Apr 2027
const PERIODS = WEEKS.map(w => w.key) // kept as `PERIODS` so existing references still work
const PERIOD_LABELS = Object.fromEntries(WEEKS.map(w => [w.key, w.label]))
const PERIOD_RANGES = Object.fromEntries(WEEKS.map(w => [w.key, w.dateRange]))

// Pick the week containing "today". On a weekend (Sat/Sun, not covered
// by any Mon-Fri range), show the week that JUST ENDED — that's the one
// still being finalized/recorded — rather than jumping ahead to next week.
function getCurrentWeekKey() {
  const t = today()
  const exact = WEEKS.find(w => t >= w.monday && t <= w.friday)
  if (exact) return exact.key

  if (!WEEKS.length) return ''
  if (t < WEEKS[0].monday) return WEEKS[0].key
  if (t > WEEKS[WEEKS.length - 1].friday) return WEEKS[WEEKS.length - 1].key

  // We're in a gap between two weeks (i.e. a weekend) — find the week
  // whose Friday most recently passed, and use that one.
  let lastEnded = WEEKS[0]
  for (const w of WEEKS) {
    if (w.friday < t) lastEnded = w
    else break
  }
  return lastEnded.key
}
const CURRENT_PERIOD = getCurrentWeekKey()

// Group weeks by month for the monthly rollup tab
function getMonthlyTotals(periodTotals) {
  // periodTotals = { [weekKey]: number }
  const byMonth = {}
  for (const w of WEEKS) {
    byMonth[w.monthKey] = byMonth[w.monthKey] || { monthKey:w.monthKey, monthLabel:w.monthLabel, total:0, weeks:[] }
    byMonth[w.monthKey].total += periodTotals[w.key] || 0
    byMonth[w.monthKey].weeks.push(w.key)
  }
  return Object.values(byMonth)
}

// ── RUNNING BALANCE CALCULATOR ────────────────────────────────
// Walks every week from the start of the school year up to (and including)
// `uptoPeriodKey`, carrying forward any shortage (still owed) or surplus
// (credit) into the next week's amount due. This means a student's "due"
// for a given week is never just that week's fee in isolation — it reflects
// their entire payment history to date.
//
// Returns, for the requested week:
//   { fee, carriedIn, amountDue, paid, balance, status }
// where status is 'paid' | 'underpaid' | 'overpaid' | 'unbilled'
// carriedIn > 0 means they owed extra coming in; carriedIn < 0 means credit.
function getRunningBalance(studentId, attendance, txns, rate, uptoPeriodKey) {
  let carry = 0
  let result = null

  for (const w of WEEKS) {
    const attRec = attendance.find(a => a.student_id === studentId && a.period === w.key)
    const days   = attRec ? attRec.days_present : 0
    const fee    = days * rate

    const paid = txns
      .filter(t => t.student_id === studentId && t.period === w.key && t.status === 'confirmed')
      .reduce((a, t) => a + Number(t.amount), 0)

    const amountDue = fee + carry
    const balance   = amountDue - paid // >0 still owed, <0 credit, 0 settled

    const status = fee === 0 && paid === 0
      ? 'unbilled'
      : balance === 0
      ? 'paid'
      : balance > 0
      ? 'underpaid'
      : 'overpaid'

    result = { weekKey: w.key, fee, carriedIn: carry, amountDue, paid, balance, status, days }

    carry = balance // feeds into next week's carriedIn
    if (w.key === uptoPeriodKey) break
  }

  return result || { weekKey: uptoPeriodKey, fee:0, carriedIn:0, amountDue:0, paid:0, balance:0, status:'unbilled', days:0 }
}

// ── STUDENT FILING NUMBER ─────────────────────────────────────
// Students are stored as "Family Name, First Name", so a plain
// alphabetical sort on `name` already sorts by family name. This
// returns a lookup of { [studentId]: filingNumber } where #1 is
// alphabetically first. Renumbers automatically as students are
// added, removed, or renamed — it's never stored, always derived.
function getFilingNumbers(students) {
  const sorted = [...students]
    .filter(s => s.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
  const map = {}
  sorted.forEach((s, i) => { map[s.id] = i + 1 })
  return map
}

// ── SMS REMINDER MESSAGE BUILDER ──────────────────────────────
// Builds the ready-to-send weekly reminder text for a guardian.
// This is opened via the phone's own Messages app (sms: link) —
// no auto-send yet. Real auto-send requires an SMS gateway account
// (e.g. Semaphore) and is a planned future upgrade.
function buildSmsMessage(student, rb, cfg, period) {
  const { fee, carriedIn, amountDue, paid, balance, status, days } = rb
  const lines = [
    `${cfg.busUnit} — Weekly Fee Update`,
    `${student.nickname || student.name} (Gr.${student.grade})`,
    `${PERIOD_LABELS[period]}: ${days} day(s) x ${peso(cfg.rate)} = ${peso(fee)}`,
  ]
  if (carriedIn !== 0) {
    lines.push(carriedIn > 0 ? `+ ${peso(carriedIn)} balance from before` : `- ${peso(Math.abs(carriedIn))} credit from before`)
  }
  lines.push(`Amount Due: ${peso(amountDue)}`)
  lines.push(`Paid: ${peso(paid)}`)
  if (status === 'paid') {
    lines.push(`Status: FULLY PAID - no balance carried. Thank you!`)
  } else if (status === 'overpaid') {
    lines.push(`Status: OVERPAID by ${peso(Math.abs(balance))} - credited next week.`)
  } else {
    lines.push(`Balance: ${peso(balance)} (carries to next week)`)
  }
  lines.push(`Pay via GCash: ${cfg.gcashNum} (${cfg.gcashName})`)
  return lines.join('\n')
}


const lbl = { display:'block', fontSize:12, fontWeight:600, color:C.muted, marginBottom:5, marginTop:12, letterSpacing:.5, textTransform:'uppercase' }
const inp = { display:'block', width:'100%', padding:'11px 14px', borderRadius:10, border:`1px solid ${C.border}`, fontSize:14, color:C.text, background:C.white, boxSizing:'border-box', outline:'none' }

// ─── WEEK NAVIGATOR ───────────────────────────────────────────
// Replaces long dropdown lists with simple ← Prev / Next → arrows,
// the current week shown clearly in the middle, and a "Today" jump-back
// button that appears once you've navigated away from the current week.
function WeekNavigator({ period, setPeriod, label = 'Viewing' }) {
  const idx = PERIODS.indexOf(period)
  const goPrev = () => { if (idx > 0) setPeriod(PERIODS[idx - 1]) }
  const goNext = () => { if (idx < PERIODS.length - 1) setPeriod(PERIODS[idx + 1]) }
  const isCurrent = period === CURRENT_PERIOD

  return (
    <div style={{ marginBottom:6 }}>
      <label style={lbl}>{label}</label>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <button onClick={goPrev} disabled={idx<=0} className="tap-bounce"
          style={{ width:38, height:38, borderRadius:11, background:idx<=0?C.border:`linear-gradient(135deg,#3D5A99,${C.navy})`, color:C.white, border:'none', fontSize:18, fontWeight:800, cursor:idx<=0?'not-allowed':'pointer', flexShrink:0 }}>
          ‹
        </button>
        <div style={{ flex:1, textAlign:'center', background:C.white, border:`1px solid ${C.border}`, borderRadius:11, padding:'8px 6px' }}>
          <div style={{ fontSize:13, fontWeight:800, color:C.text }}>{PERIOD_LABELS[period]}</div>
          <div style={{ fontSize:10, color:C.muted }}>{PERIOD_RANGES[period]}</div>
        </div>
        <button onClick={goNext} disabled={idx>=PERIODS.length-1} className="tap-bounce"
          style={{ width:38, height:38, borderRadius:11, background:idx>=PERIODS.length-1?C.border:`linear-gradient(135deg,#3D5A99,${C.navy})`, color:C.white, border:'none', fontSize:18, fontWeight:800, cursor:idx>=PERIODS.length-1?'not-allowed':'pointer', flexShrink:0 }}>
          ›
        </button>
      </div>
      {!isCurrent && (
        <button onClick={()=>setPeriod(CURRENT_PERIOD)} className="tap-shrink"
          style={{ marginTop:6, background:'none', border:'none', color:C.gcash, fontSize:11, fontWeight:700, cursor:'pointer', padding:0 }}>
          ↺ Jump to current week
        </button>
      )}
    </div>
  )
}

// ─── OPERATOR / DRIVER CONTACTS ───────────────────────────────
const CONTACTS = [
  { role:'Service Operator', name:'LMG',          phone:'09178514777' },
  { role:'Driver',           name:'Didot Galos',  phone:'09812520961' },
]

function ContactFooter() {
  return (
    <div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden', marginTop:4 }}>
      <div style={{ padding:'12px 16px', background:C.cream, fontSize:12, fontWeight:700, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>
        📞 Direct Contact
      </div>
      {CONTACTS.map((c,i) => (
        <a key={i} href={`tel:${c.phone}`} className="tap-shrink"
          style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 16px', borderTop:i>0?`1px solid ${C.border}`:'none', textDecoration:'none' }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{c.name}</div>
            <div style={{ fontSize:11, color:C.muted }}>{c.role}</div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6, background:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, padding:'8px 16px', borderRadius:24, fontSize:13, fontWeight:800, boxShadow:`0 3px 10px ${C.gcash}55` }}>
            📞 {c.phone}
          </div>
        </a>
      ))}
    </div>
  )
}

// ─── GLOBAL TAP ANIMATION STYLES ──────────────────────────────
// Injected once; gives every interactive element a satisfying
// press-down/scale-back feel, plus a subtle pop-in on appearance.
function TapStyles() {
  return (
    <style>{`
      .tap-shrink { transition: transform .12s ease, box-shadow .12s ease, filter .12s ease; }
      .tap-shrink:active { transform: scale(0.93); filter: brightness(0.96); }
      .tap-bounce { transition: transform .15s cubic-bezier(.34,1.56,.64,1), box-shadow .15s ease; }
      .tap-bounce:active { transform: scale(0.88); }
      .tap-pop { animation: popIn .25s cubic-bezier(.34,1.56,.64,1); }
      @keyframes popIn { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @keyframes pulseGlow { 0%,100% { box-shadow: 0 4px 14px rgba(0,125,255,.45); } 50% { box-shadow: 0 6px 22px rgba(0,125,255,.7); } }
      .pulse-glow { animation: pulseGlow 2.2s ease-in-out infinite; }
      * { -webkit-tap-highlight-color: transparent; }
    `}</style>
  )
}

// ═══════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [user,     setUser]     = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [role,     setRole]     = useState(null)        // 'admin' | 'parent' | null (still loading)
  const [myStudent,setMyStudent]= useState(null)         // parent's linked student record
  const [screen,   setScreen]   = useState('home')
  const [students, setStudents] = useState([])
  const [txns,     setTxns]     = useState([])
  const [expenses, setExpenses] = useState([])
  const [attendance, setAttendanceList] = useState([])
  const [settings, setSettings] = useState({ daily_rate:'240', school_days:'22', driver_rate:'500', gcash_number:'09XX-XXX-XXXX', gcash_name:'Lucky Shining Star Dev. Corp.', bus_unit:'NEB 1887' })
  const [toast,    setToast]    = useState(null)
  const [payState, setPayState] = useState(null)
  const [selectedStudentId, setSelectedStudentId] = useState(null)

  // ── AUTH ───────────────────────────────────────────────────
  useEffect(() => {
    const { data: { subscription } } = onAuthChange(u => {
      setUser(u)
      setLoading(false)
    })
    return () => subscription.unsubscribe()
  }, [])

  // ── DETERMINE ROLE (admin vs parent) ────────────────────────
  useEffect(() => {
    if (!user) { setRole(null); return }
    loadUserRole(user.email)
      .then(({ role, student }) => { setRole(role); setMyStudent(student) })
      .catch(err => showToast(err.message, 'error'))
  }, [user])

  // ── LOAD DATA WHEN LOGGED IN ───────────────────────────────
  // Parents only need their own transactions/attendance; drivers only
  // need students + attendance (no money data, RLS blocks it anyway).
  useEffect(() => {
    if (!user || !role) return
    if (role === 'parent') {
      if (!myStudent) return // no linked student yet — handled in UI
      Promise.all([
        loadTransactions({ studentId: myStudent.id }).then(setTxns),
        loadAttendance().then(setAttendanceList),
        loadSettings().then(setSettings),
      ]).catch(err => showToast(err.message, 'error'))
    } else if (role === 'driver') {
      Promise.all([
        loadStudents().then(setStudents),
        loadAttendance().then(setAttendanceList),
        loadSettings().then(setSettings), // needed to know daily rate / week length, read-only display
      ]).catch(err => showToast(err.message, 'error'))
    } else {
      Promise.all([
        loadStudents().then(setStudents),
        loadTransactions().then(setTxns),
        loadExpenses().then(setExpenses),
        loadSettings().then(setSettings),
        loadAttendance().then(setAttendanceList),
      ]).catch(err => showToast(err.message, 'error'))
    }
  }, [user, role, myStudent])

  // ── REALTIME SUBSCRIPTION ──────────────────────────────────
  useEffect(() => {
    if (!user || role === 'driver') return // drivers don't touch transactions
    const unsub = subscribeToTransactions(newTxn => {
      if (role === 'parent' && myStudent && newTxn.student_id !== myStudent.id) return
      setTxns(prev => [newTxn, ...prev])
      showToast('New payment recorded!', 'info')
    })
    return unsub
  }, [user, role, myStudent])

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const handleAddTransaction = async (txn) => {
    try {
      await addTransaction(txn)
      setTxns(prev => [txn, ...prev])
      showToast(`Payment saved! Ref: ${txn.ref}`)
      setPayState({ ...txn, studentName: students.find(s => s.id === txn.student_id)?.name })
      setScreen('receipt')
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const handleSaveSettings = async (updates) => {
    try {
      await saveSettings(updates)
      setSettings(updates)
      showToast('Settings saved!')
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const handleSetAttendance = async (studentId, period, days) => {
    try {
      const saved = await setAttendance(studentId, period, days)
      setAttendanceList(prev => {
        const exists = prev.find(a => a.student_id === studentId && a.period === period)
        return exists
          ? prev.map(a => (a.student_id === studentId && a.period === period) ? saved : a)
          : [...prev, saved]
      })
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const cfg = {
    rate:       Number(settings.daily_rate  || 240),
    days:       5, // fixed: Mon–Fri school week
    driverRate: Number(settings.driver_rate || 500),
    gcashNum:   settings.gcash_number || '09XX-XXX-XXXX',
    gcashName:  settings.gcash_name   || 'Lucky Shining Star Dev. Corp.',
    busUnit:    settings.bus_unit     || 'NEB 1887',
  }

  if (loading) return <Splash/>
  if (!user)   return <LoginScreen onLogin={(u) => setUser(u)} showToast={showToast}/>
  if (!role)   return <Splash/>   // role still loading

  // ── PARENT VIEW ────────────────────────────────────────────
  if (role === 'parent') {
    return (
      <ParentApp
        user={user}
        myStudent={myStudent}
        txns={txns}
        cfg={cfg}
        attendance={attendance}
        onSignOut={async()=>{ await signOut(); setUser(null) }}
        onAddTransaction={handleAddTransaction}
        onSetAttendance={handleSetAttendance}
        payState={payState}
        setPayState={setPayState}
        toast={toast}
      />
    )
  }

  // ── DRIVER VIEW ────────────────────────────────────────────
  if (role === 'driver') {
    return (
      <DriverApp
        user={user}
        students={students}
        attendance={attendance}
        cfg={cfg}
        onSetAttendance={handleSetAttendance}
        onSignOut={async()=>{ await signOut(); setUser(null) }}
        toast={toast}
      />
    )
  }

  // ── ADMIN VIEW ─────────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto', position:'relative' }}>
      <TapStyles/>
      <div style={{ background: screen==='home' ? C.gcash : C.navy, height:8 }}/>

      {screen==='home'     && <ScreenHome     setScreen={setScreen} txns={txns} cfg={cfg} students={students}/>}
      {screen==='pay'      && <ScreenPay      setScreen={setScreen} onSave={handleAddTransaction} cfg={cfg} students={students} payState={payState} setPayState={setPayState}/>}
      {screen==='history'  && <ScreenHistory  setScreen={setScreen} txns={txns} students={students} cfg={cfg} attendance={attendance}/>}
      {screen==='exportPdf' && <ScreenExportPdf setScreen={setScreen} txns={txns} students={students} expenses={expenses} cfg={cfg}/>}
      {screen==='analytics' && <ScreenAnalytics setScreen={setScreen} txns={txns} expenses={expenses}/>}
      {screen==='smsReminders' && <ScreenSmsReminders setScreen={setScreen} students={students} txns={txns} attendance={attendance} cfg={cfg}/>}
      {screen==='students' && <ScreenStudents setScreen={setScreen} txns={txns} cfg={cfg} students={students} setPayState={setPayState} attendance={attendance} setSelectedStudentId={setSelectedStudentId}/>}
      {screen==='studentDetail' && <ScreenStudentDetail setScreen={setScreen} studentId={selectedStudentId} students={students} txns={txns} cfg={cfg} attendance={attendance} setPayState={setPayState}/>}
      {screen==='studentStatement' && <ScreenStudentStatement setScreen={setScreen} studentId={selectedStudentId} students={students} txns={txns} expenses={expenses} attendance={attendance} cfg={cfg}/>}
      {screen==='expenses' && <ScreenExpenses setScreen={setScreen} expenses={expenses} setExpenses={setExpenses} showToast={showToast} attendance={attendance} cfg={cfg}/>}
      {screen==='settings' && <ScreenSettings setScreen={setScreen} settings={settings} onSave={handleSaveSettings} onSignOut={async()=>{ await signOut(); setUser(null) }}/>}
      {screen==='manage'   && <ScreenManageStudents setScreen={setScreen} students={students} setStudents={setStudents} showToast={showToast}/>}
      {screen==='attendance' && <ScreenAttendance setScreen={setScreen} students={students} attendance={attendance} cfg={cfg} onSetAttendance={handleSetAttendance}/>}
      {screen==='receipt'  && <ScreenReceipt  setScreen={setScreen} payState={payState} cfg={cfg}/>}

      {screen !== 'receipt' && (
        <nav style={{ position:'fixed', bottom:0, left:'50%', transform:'translateX(-50%)', width:'100%', maxWidth:430, background:C.white, borderTop:`1px solid ${C.border}`, display:'flex', zIndex:200, boxShadow:'0 -4px 16px rgba(0,0,0,.1)' }}>
          {[
            { key:'home',      icon:'🏠', label:'Home',      grad:['#3D5A99',C.navyMd] },
            { key:'students',  icon:'👥', label:'Students',  grad:['#3D5A99',C.navyMd] },
            { key:'pay',       icon:'💳', label:'Pay',      grad:[C.gcash,C.gcashDk] },
            { key:'history',   icon:'📋', label:'History',  grad:['#28C76F',C.green] },
            { key:'expenses',  icon:'📊', label:'Expenses', grad:[C.amberLt,C.amber] },
            { key:'analytics', icon:'📈', label:'Analytics',grad:['#9B59B6','#6C3483'] },
          ].map(n => (
            <button key={n.key} onClick={()=>{ if(n.key==='pay') setPayState(null); setScreen(n.key) }} className="tap-bounce"
              style={{ flex:1, border:'none', background:'transparent', cursor:'pointer', padding:'8px 2px 9px', display:'flex', flexDirection:'column', alignItems:'center', gap:3, minWidth:0 }}>
              <div style={{ width:32, height:32, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:17,
                  background: screen===n.key ? `linear-gradient(135deg,${n.grad[0]},${n.grad[1]})` : 'transparent',
                  boxShadow: screen===n.key ? `0 3px 10px ${n.grad[1]}55` : 'none',
                  transition:'all .15s' }}>{n.icon}</div>
              <span style={{ fontSize:9, fontWeight:screen===n.key?800:500, color:screen===n.key?C.gcash:C.muted, whiteSpace:'nowrap' }}>{n.label}</span>
            </button>
          ))}
        </nav>
      )}

      {toast && (
        <div style={{ position:'fixed', top:20, left:'50%', transform:'translateX(-50%)', background: toast.type==='success'?C.green:toast.type==='info'?C.gcash:C.red, color:C.white, padding:'12px 20px', borderRadius:12, fontSize:13, fontWeight:600, zIndex:9999, boxShadow:'0 4px 20px rgba(0,0,0,.25)', maxWidth:360, textAlign:'center' }}>
          {toast.type==='success'?'✅ ':toast.type==='info'?'ℹ️ ':'❌ '}{toast.msg}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// PARENT APP — simplified, single-student view
// ═══════════════════════════════════════════════════════════
function ParentApp({ user, myStudent, txns, cfg, attendance, onSignOut, onAddTransaction, onSetAttendance, payState, setPayState, toast }) {
  const [screen, setScreen] = useState('home') // 'home' | 'pay' | 'receipt' | 'history' | 'attendance'

  if (!myStudent) {
    return (
      <div style={{ minHeight:'100vh', background:C.cream, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:24, textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>⚠️</div>
        <div style={{ fontSize:16, fontWeight:700, color:C.text, marginBottom:8 }}>No Student Linked</div>
        <div style={{ fontSize:13, color:C.muted, marginBottom:20, maxWidth:300 }}>
          Your account ({user.email}) isn't linked to a student yet. Please ask the bus admin to add your email under your child's record in Manage Students.
        </div>
        <button onClick={onSignOut} style={{ padding:'10px 20px', background:C.navy, color:C.white, border:'none', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer' }}>Sign Out</button>
      </div>
    )
  }

  const rb = getRunningBalance(myStudent.id, attendance, txns, cfg.rate, CURRENT_PERIOD)
  const { fee: currentFee, carriedIn, amountDue, paid: periodPaid, balance, status, days } = rb
  const totalPaidAllTime = txns.filter(t => t.status === 'confirmed').reduce((a,t)=>a+Number(t.amount),0)

  if (screen === 'receipt' && payState) {
    return <ScreenReceipt setScreen={setScreen} payState={payState} cfg={cfg}/>
  }

  if (screen === 'pay') {
    return (
      <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto' }}>
        <TapStyles/>
        <ParentPayFlow
          student={myStudent}
          cfg={cfg}
          suggestedAmount={balance > 0 ? balance : currentFee}
          onCancel={()=>setScreen('home')}
          onSave={(txn)=>{ onAddTransaction(txn); setScreen('receipt') }}
        />
      </div>
    )
  }

  if (screen === 'history') {
    return (
      <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto', paddingBottom:24 }}>
        <TapStyles/>
        <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
          <button onClick={()=>setScreen('home')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
          <span style={{ fontSize:16, fontWeight:700, color:C.white }}>Payment History</span>
        </div>
        <div style={{ padding:16 }}>
          {txns.length === 0 && <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14 }}>No payments recorded yet.</div>}
          {txns.map((t,i) => (
            <div key={i} style={{ background:C.white, borderRadius:12, padding:'12px 14px', marginBottom:8, border:`1px solid ${C.border}`, display:'flex', gap:10, alignItems:'center' }}>
              <div style={{ width:38, height:38, borderRadius:10, background:t.method==='GCash'?C.gcashLt:C.yellow, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
                {t.method==='GCash'?'💙':'💵'}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{PERIOD_LABELS[t.period] || t.period}</div>
                <div style={{ fontSize:11, color:C.muted, fontFamily:'monospace' }}>{t.ref}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:14, fontWeight:800, color:C.green }}>{peso(t.amount)}</div>
                <div style={{ fontSize:10, color:C.muted }}>{fmtDate(t.date)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (screen === 'attendance') {
    return (
      <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto', paddingBottom:24 }}>
        <TapStyles/>
        <ParentAttendanceCheck student={myStudent} cfg={cfg} attendance={attendance} onSetAttendance={onSetAttendance} onBack={()=>setScreen('home')}/>
      </div>
    )
  }

  if (screen === 'statement') {
    return (
      <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto', paddingBottom:24 }}>
        <TapStyles/>
        <StudentStatementView student={myStudent} txns={txns} attendance={attendance} cfg={cfg} onBack={()=>setScreen('home')}/>
      </div>
    )
  }

  // ── HOME (default) ──────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto', position:'relative', paddingBottom:24 }}>
      <TapStyles/>
      <div style={{ background:`linear-gradient(160deg,${C.gcash} 0%,${C.gcashDk} 100%)`, padding:'24px 20px 32px', color:C.white }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:11, opacity:.8, letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>BNHS-RSHS School Service</div>
            <div style={{ fontSize:20, fontWeight:900 }}>{myStudent.nickname || myStudent.name}</div>
            <div style={{ fontSize:12, opacity:.75, marginTop:2 }}>Grade {myStudent.grade} · {cfg.busUnit}</div>
          </div>
          <button onClick={onSignOut} style={{ background:'rgba(255,255,255,.2)', border:'none', borderRadius:10, padding:'8px 14px', color:C.white, fontSize:12, fontWeight:600, cursor:'pointer' }}>Sign Out</button>
        </div>
        <LiveClock light/>

        <div style={{ background:'rgba(255,255,255,.15)', borderRadius:16, padding:'16px 20px', marginTop:20 }}>
          <div style={{ fontSize:11, opacity:.8, letterSpacing:1, textTransform:'uppercase' }}>{PERIOD_LABELS[CURRENT_PERIOD]} Balance</div>
          <div style={{ fontSize:34, fontWeight:900, marginTop:4 }}>{balance > 0 ? peso(balance) : '₱0'}</div>
          <div style={{ fontSize:12, opacity:.8, marginTop:2 }}>
            {days} days × {peso(cfg.rate)} = {peso(currentFee)}
            {carriedIn !== 0 && (carriedIn > 0 ? ` + ${peso(carriedIn)} owed from before` : ` − ${peso(Math.abs(carriedIn))} credit from before`)}
          </div>
          {status === 'paid' && (
            <div style={{ marginTop:10, background:'rgba(255,255,255,.25)', borderRadius:10, padding:'8px 12px', fontSize:12, fontWeight:800 }}>
              ✅ FULLY PAID — Current, no forwarded balance
            </div>
          )}
          {status === 'overpaid' && (
            <div style={{ marginTop:10, background:'rgba(255,255,255,.25)', borderRadius:10, padding:'8px 12px', fontSize:12, fontWeight:800 }}>
              💰 Overpaid by {peso(Math.abs(balance))} — credited to next week
            </div>
          )}
        </div>
      </div>

      <div style={{ padding:'16px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
          <div style={{ background:C.white, borderRadius:12, padding:'14px', border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:11, color:C.muted }}>Total Paid (All Time)</div>
            <div style={{ fontSize:20, fontWeight:900, color:C.green, marginTop:4 }}>{peso(totalPaidAllTime)}</div>
          </div>
          <button onClick={()=>setScreen('attendance')} className="tap-shrink" style={{ background:C.white, borderRadius:12, padding:'14px', border:`1px solid ${C.border}`, textAlign:'left', cursor:'pointer' }}>
            <div style={{ fontSize:11, color:C.muted }}>Days Present ({PERIOD_LABELS[CURRENT_PERIOD]})</div>
            <div style={{ fontSize:20, fontWeight:900, color:C.navy, marginTop:4 }}>{days} / 5</div>
          </button>
        </div>

        <button onClick={()=>setScreen('pay')} className="tap-bounce"
          style={{ width:'100%', padding:16, background:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:'pointer', marginBottom:12, boxShadow:`0 4px 14px ${C.gcash}55` }}>
          💙 Pay via GCash or Cash
        </button>
        <button onClick={()=>setScreen('attendance')} className="tap-bounce"
          style={{ width:'100%', padding:14, background:`linear-gradient(135deg,${C.amberLt},${C.amber})`, color:C.navy, border:'none', borderRadius:14, fontSize:14, fontWeight:800, cursor:'pointer', marginBottom:12, boxShadow:`0 4px 12px ${C.amber}44` }}>
          🗓 Check / Update Days Present
        </button>
        <button onClick={()=>setScreen('history')} className="tap-bounce"
          style={{ width:'100%', padding:14, background:C.white, color:C.navy, border:`1px solid ${C.border}`, borderRadius:14, fontSize:14, fontWeight:700, cursor:'pointer', marginBottom:12 }}>
          📋 View Payment History
        </button>
        <button onClick={()=>setScreen('statement')} className="tap-bounce"
          style={{ width:'100%', padding:14, background:`linear-gradient(135deg,#5FE39A,${C.green})`, color:C.white, border:'none', borderRadius:14, fontSize:14, fontWeight:800, cursor:'pointer', marginBottom:16, boxShadow:`0 4px 12px ${C.green}44` }}>
          🧾 View Statement
        </button>

        <ContactFooter/>
      </div>

      {toast && (
        <div style={{ position:'fixed', top:20, left:'50%', transform:'translateX(-50%)', background: toast.type==='success'?C.green:toast.type==='info'?C.gcash:C.red, color:C.white, padding:'12px 20px', borderRadius:12, fontSize:13, fontWeight:600, zIndex:9999, boxShadow:'0 4px 20px rgba(0,0,0,.25)', maxWidth:360, textAlign:'center' }}>
          {toast.type==='success'?'✅ ':toast.type==='info'?'ℹ️ ':'❌ '}{toast.msg}
        </div>
      )}
    </div>
  )
}

// ─── PARENT PAY FLOW (simplified — student is fixed, just amount/method) ────
function ParentPayFlow({ student, cfg, suggestedAmount, onCancel, onSave }) {
  const [period,   setPeriod]   = useState(CURRENT_PERIOD)
  const [method,   setMethod]   = useState('GCash')
  const [amount,   setAmount]   = useState(String(suggestedAmount))
  const [gcashRef, setGcashRef] = useState('')
  const [step,     setStep]     = useState(1)
  const [confirming, setConfirming] = useState(false)
  const [countdown,  setCountdown]  = useState(null)
  const intervalRef = useRef(null)

  const startCountdown = () => {
    setConfirming(true); let secs = 30; setCountdown(secs)
    intervalRef.current = setInterval(() => {
      secs--; setCountdown(secs)
      if (secs <= 0) { clearInterval(intervalRef.current); setConfirming(false); setCountdown(null) }
    }, 1000)
  }

  const confirmPayment = () => {
    clearInterval(intervalRef.current)
    const txn = { id: uid(), student_id: student.id, amount: Number(amount), method, date: today(), period, ref: gcashRef || refid(method), status:'confirmed', note:'' }
    onSave({ ...txn, studentName: student.name })
  }

  if (step === 1) return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.white, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, borderBottom:`1px solid ${C.border}` }}>
        <button onClick={onCancel} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.navyMd, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.text }}>Make a Payment</span>
      </div>
      <div style={{ padding:16 }}>
        <label style={lbl}>Pay Period</label>
        <select value={period} onChange={e=>setPeriod(e.target.value)} style={inp}>
          {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </select>

        <label style={lbl}>Amount (₱)</label>
        <div style={{ position:'relative' }}>
          <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)', color:C.gcash, fontWeight:700, fontSize:16 }}>₱</span>
          <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} style={{ ...inp, paddingLeft:28, fontSize:20, fontWeight:800, color:C.gcash }}/>
        </div>

        <label style={lbl}>Payment Method</label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
          {['GCash','Cash'].map(m=>(
            <button key={m} onClick={()=>setMethod(m)} className="tap-bounce"
              style={{ padding:16, background:method===m?`linear-gradient(135deg,${m==='GCash'?C.gcash:C.amberLt},${m==='GCash'?C.gcashDk:C.amber})`:C.white, color:method===m?C.white:(m==='GCash'?C.gcash:C.yellowDk), border:`2px solid ${method===m?(m==='GCash'?C.gcash:C.amber):C.border}`, borderRadius:14, fontSize:14, fontWeight:800, cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:6, boxShadow:method===m?`0 4px 14px ${m==='GCash'?C.gcash:C.amber}55`:'none' }}>
              <span style={{ fontSize:28 }}>{m==='GCash'?'💙':'💵'}</span>{m}
            </button>
          ))}
        </div>

        <button onClick={()=>setStep(2)} disabled={!amount || Number(amount)<=0} className="tap-bounce"
          style={{ width:'100%', padding:15, background:Number(amount)>0?`linear-gradient(135deg,${C.gcash},${C.gcashDk})`:'#ccc', color:C.white, border:'none', borderRadius:14, fontSize:16, fontWeight:800, cursor:Number(amount)>0?'pointer':'not-allowed' }}>
          Continue →
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.white, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, borderBottom:`1px solid ${C.border}` }}>
        <button onClick={()=>setStep(1)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.navyMd, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.text }}>{method==='GCash' ? 'GCash Payment' : 'Confirm Cash'}</span>
      </div>
      <div style={{ padding:16 }}>
        {method === 'GCash' ? (
          <>
            <div style={{ background:C.gcashLt, borderRadius:16, padding:20, textAlign:'center', border:`2px solid ${C.gcash}33`, marginBottom:16 }}>
              <div style={{ fontSize:13, color:C.gcash, fontWeight:600, marginBottom:8 }}>SEND GCASH TO</div>
              <div style={{ fontSize:28, fontWeight:900, color:C.gcash }}>{cfg.gcashNum}</div>
              <div style={{ fontSize:14, fontWeight:600, color:C.navyMd, marginTop:4 }}>{cfg.gcashName}</div>
              <div style={{ fontSize:38, fontWeight:900, color:C.gcashDk, margin:'16px 0' }}>{peso(Number(amount))}</div>
              <div style={{ fontSize:40, marginBottom:8 }}>📱</div>
              <div style={{ fontSize:11, color:C.muted }}>GCash → Send Money → Scan QR</div>
            </div>
            <label style={lbl}>GCash Reference Number</label>
            <input value={gcashRef} onChange={e=>setGcashRef(e.target.value)} placeholder="e.g. GC-8821451" style={{ ...inp, fontFamily:'monospace', fontWeight:700, marginBottom:16 }}/>
            {!confirming
              ? <button onClick={startCountdown} disabled={!gcashRef} className="tap-bounce"
                  style={{ width:'100%', padding:15, background:gcashRef?`linear-gradient(135deg,${C.gcash},${C.gcashDk})`:'#ccc', color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:gcashRef?'pointer':'not-allowed' }}>
                  💙 Confirm GCash Payment
                </button>
              : <button onClick={confirmPayment} className="tap-bounce"
                  style={{ width:'100%', padding:15, background:`linear-gradient(135deg,${C.green},#157f3b)`, color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:'pointer' }}>
                  ✅ Payment Sent — Confirm ({countdown}s)
                </button>
            }
          </>
        ) : (
          <>
            <div style={{ background:C.yellow, borderRadius:16, padding:20, textAlign:'center', border:`2px solid ${C.amberLt}`, marginBottom:16 }}>
              <div style={{ fontSize:13, color:C.yellowDk, fontWeight:600, marginBottom:4 }}>CASH TO HAND OVER</div>
              <div style={{ fontSize:42, fontWeight:900, color:C.yellowDk }}>{peso(Number(amount))}</div>
            </div>
            <button onClick={confirmPayment} className="tap-bounce"
              style={{ width:'100%', padding:15, background:`linear-gradient(135deg,${C.amber},${C.amberLt})`, color:C.navy, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:'pointer' }}>
              💵 Confirm Cash Given
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── PARENT ATTENDANCE CHECK — view driver's input, agree or override ──────
function ParentAttendanceCheck({ student, cfg, attendance, onSetAttendance, onBack }) {
  const [period, setPeriod] = useState(CURRENT_PERIOD)

  const rec  = attendance.find(a => a.student_id === student.id && a.period === period)
  const days = rec ? rec.days_present : 0
  const fee  = days * cfg.rate

  const adjust = (delta) => {
    const next = Math.max(0, Math.min(5, days + delta))
    onSetAttendance(student.id, period, next)
  }
  const setDirect = (value) => {
    const num = Math.max(0, Math.min(5, Number(value) || 0))
    onSetAttendance(student.id, period, num)
  }

  return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={onBack} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white }}>Check Days Present</span>
      </div>

      <div style={{ padding:16 }}>
        <div style={{ background:C.gcashLt, borderRadius:12, padding:'12px 14px', marginBottom:16, border:`1px solid ${C.gcash}33` }}>
          <div style={{ fontSize:12, color:C.gcash, fontWeight:600 }}>FOR</div>
          <div style={{ fontSize:16, fontWeight:700, color:C.navyMd }}>{student.name}{student.nickname && ` "${student.nickname}"`}</div>
        </div>

        <WeekNavigator period={period} setPeriod={setPeriod} label="Week"/>


        <div style={{ background:C.white, borderRadius:14, padding:16, border:`1px solid ${C.border}`, marginBottom:16 }}>
          <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>
            {rec ? 'This is what was last entered — by the driver or a previous update. You can agree (leave it) or correct it below.' : 'No attendance logged yet for this week.'}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
            <button onClick={()=>adjust(-1)} className="tap-bounce"
              style={{ width:46, height:46, borderRadius:14, background:`linear-gradient(135deg,#FF8A80,${C.red})`, color:C.white, border:'none', fontSize:24, fontWeight:900, cursor:'pointer', flexShrink:0, boxShadow:`0 3px 10px ${C.red}55` }}>
              −
            </button>
            <input type="number" value={days} min={0} max={5}
              onChange={e=>setDirect(e.target.value)}
              style={{ flex:1, textAlign:'center', padding:'12px 4px', borderRadius:13, border:`2px solid ${C.border}`, fontSize:22, fontWeight:800, color:C.navy }}/>
            <button onClick={()=>adjust(1)} className="tap-bounce"
              style={{ width:46, height:46, borderRadius:14, background:`linear-gradient(135deg,#5FE39A,${C.green})`, color:C.white, border:'none', fontSize:24, fontWeight:900, cursor:'pointer', flexShrink:0, boxShadow:`0 3px 10px ${C.green}55` }}>
              +
            </button>
            <span style={{ fontSize:11, color:C.muted, width:40, flexShrink:0 }}>/ 5 days</span>
          </div>
          <div style={{ textAlign:'center', fontSize:13, color:C.muted }}>
            Fee for this week: <b style={{ color:C.text }}>{peso(fee)}</b> ({days} × {peso(cfg.rate)})
          </div>
        </div>

        <div style={{ background:C.yellow, borderRadius:10, padding:'10px 14px', fontSize:12, color:C.yellowDk }}>
          ℹ️ If you don't update this, the driver's number is used for billing. Any change you save here becomes the number used.
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// DRIVER APP — single purpose: log days present, all students
// ═══════════════════════════════════════════════════════════
function DriverApp({ user, students, attendance, cfg, onSetAttendance, onSignOut, toast }) {
  const [period, setPeriod] = useState(CURRENT_PERIOD)
  const activeStudents = students.filter(s => s.active !== false).sort((a,b) => a.name.localeCompare(b.name))
  const filingNumbers = getFilingNumbers(students)

  const getDays = (studentId) => {
    const rec = attendance.find(a => a.student_id === studentId && a.period === period)
    return rec ? rec.days_present : 0
  }

  const adjust = (studentId, delta) => {
    const next = Math.max(0, Math.min(5, getDays(studentId) + delta))
    onSetAttendance(studentId, period, next)
  }

  const setDirect = (studentId, value) => {
    const num = Math.max(0, Math.min(5, Number(value) || 0))
    onSetAttendance(studentId, period, num)
  }

  const totalDaysLogged = activeStudents.reduce((a,s) => a + getDays(s.id), 0)
  const studentsLogged  = activeStudents.filter(s => attendance.find(a => a.student_id===s.id && a.period===period)).length

  return (
    <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto', position:'relative', paddingBottom:24 }}>
      <TapStyles/>
      <div style={{ background:`linear-gradient(160deg,${C.gcash} 0%,${C.gcashDk} 100%)`, padding:'24px 20px 28px', color:C.white }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:11, opacity:.8, letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Driver Attendance</div>
            <div style={{ fontSize:20, fontWeight:900 }}>{cfg.busUnit}</div>
            <div style={{ fontSize:12, opacity:.75, marginTop:2 }}>Logged in as {user.email}</div>
          </div>
          <button onClick={onSignOut} style={{ background:'rgba(255,255,255,.2)', border:'none', borderRadius:10, padding:'8px 14px', color:C.white, fontSize:12, fontWeight:600, cursor:'pointer' }}>Sign Out</button>
        </div>
        <LiveClock light/>

        <div style={{ background:'rgba(255,255,255,.15)', borderRadius:16, padding:'14px 18px', marginTop:18 }}>
          <div style={{ fontSize:11, opacity:.8, letterSpacing:1, textTransform:'uppercase' }}>{PERIOD_LABELS[period]}</div>
          <div style={{ fontSize:13, opacity:.9, marginTop:4 }}>{studentsLogged}/{activeStudents.length} students logged · {totalDaysLogged} total days</div>
        </div>
      </div>

      <div style={{ padding:16 }}>
        <WeekNavigator period={period} setPeriod={setPeriod} label="Week"/>
        <div style={{ fontSize:11, color:C.muted, marginBottom:16 }}>Tap −/+ or type the day count for each student.</div>

        {activeStudents.map(s => {
          const days = getDays(s.id)
          return (
            <div key={s.id} style={{ background:C.white, borderRadius:12, padding:'12px 14px', marginBottom:8, border:`1px solid ${C.border}` }}>
              <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:10 }}>
                <div style={{ width:26, height:26, borderRadius:8, background:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.amberLt, fontSize:12, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  {filingNumbers[s.id]}
                </div>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{s.name}{s.nickname && <span style={{ color:C.muted, fontWeight:500 }}> "{s.nickname}"</span>}</div>
                  <div style={{ fontSize:11, color:C.muted }}>Grade {s.grade}</div>
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <button onClick={()=>adjust(s.id, -1)} className="tap-bounce"
                  style={{ width:42, height:42, borderRadius:13, background:`linear-gradient(135deg,#FF8A80,${C.red})`, color:C.white, border:'none', fontSize:22, fontWeight:900, cursor:'pointer', flexShrink:0, boxShadow:`0 3px 10px ${C.red}55` }}>
                  −
                </button>
                <input type="number" value={days} min={0} max={5}
                  onChange={e=>setDirect(s.id, e.target.value)}
                  style={{ flex:1, textAlign:'center', padding:'10px 4px', borderRadius:11, border:`2px solid ${C.border}`, fontSize:18, fontWeight:800, color:C.navy }}/>
                <button onClick={()=>adjust(s.id, 1)} className="tap-bounce"
                  style={{ width:42, height:42, borderRadius:13, background:`linear-gradient(135deg,#5FE39A,${C.green})`, color:C.white, border:'none', fontSize:22, fontWeight:900, cursor:'pointer', flexShrink:0, boxShadow:`0 3px 10px ${C.green}55` }}>
                  +
                </button>
                <span style={{ fontSize:11, color:C.muted, width:40, flexShrink:0 }}>/ 5 days</span>
              </div>
            </div>
          )
        })}
        {activeStudents.length === 0 && (
          <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14 }}>No active students yet.</div>
        )}
      </div>

      {toast && (
        <div style={{ position:'fixed', top:20, left:'50%', transform:'translateX(-50%)', background: toast.type==='success'?C.green:toast.type==='info'?C.gcash:C.red, color:C.white, padding:'12px 20px', borderRadius:12, fontSize:13, fontWeight:600, zIndex:9999, boxShadow:'0 4px 20px rgba(0,0,0,.25)', maxWidth:360, textAlign:'center' }}>
          {toast.type==='success'?'✅ ':toast.type==='info'?'ℹ️ ':'❌ '}{toast.msg}
        </div>
      )}
    </div>
  )
}

function Splash() {
  return (
    <div style={{ minHeight:'100vh', background:`linear-gradient(160deg,${C.gcash},${C.gcashDk})`, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:12 }}>
      <div style={{ width:64, height:64, background:C.amber, borderRadius:18, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:22, color:C.navy }}>NEB</div>
      <div style={{ color:C.white, fontSize:18, fontWeight:700 }}>NEB 1887</div>
      <div style={{ color:'rgba(255,255,255,.7)', fontSize:13 }}>Loading…</div>
    </div>
  )
}

// ─── LOGIN ────────────────────────────────────────────────────
function LoginScreen({ onLogin, showToast }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [busy,     setBusy]     = useState(false)

  const handleLogin = async () => {
    if (!email || !password) return
    setBusy(true)
    try {
      const { user } = await signIn(email, password)
      onLogin(user)
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight:'100vh', background:`linear-gradient(160deg,${C.gcash} 0%,${C.gcashDk} 100%)`, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ width:72, height:72, background:C.amber, borderRadius:20, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:26, color:C.navy, marginBottom:16 }}>NEB</div>
      <div style={{ fontSize:24, fontWeight:900, color:C.white, marginBottom:4 }}>NEB 1887</div>
      <div style={{ fontSize:13, color:'rgba(255,255,255,.75)', marginBottom:32 }}>Lucky Shining Star Dev. Corp.</div>

      <div style={{ background:C.white, borderRadius:20, padding:24, width:'100%', maxWidth:360 }}>
        <div style={{ fontSize:16, fontWeight:700, color:C.text, marginBottom:20 }}>Sign In</div>
        <label style={lbl}>Email</label>
        <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="admin@neb1887.com" style={inp} onKeyDown={e=>e.key==='Enter'&&handleLogin()}/>
        <label style={lbl}>Password</label>
        <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" style={inp} onKeyDown={e=>e.key==='Enter'&&handleLogin()}/>
        <button onClick={handleLogin} disabled={busy}
          style={{ width:'100%', padding:14, background:busy?C.muted:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, border:'none', borderRadius:12, fontSize:15, fontWeight:800, cursor:busy?'wait':'pointer', marginTop:20, boxShadow:`0 4px 14px ${C.gcash}44` }}>
          {busy ? 'Signing in…' : 'Sign In →'}
        </button>
        <div style={{ fontSize:11, color:C.muted, textAlign:'center', marginTop:14 }}>
          Create your admin account in Supabase Dashboard → Authentication → Users
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: HOME
// ═══════════════════════════════════════════════════════════
// ─── LIVE CLOCK — shows real device date/time so the active week is
// always verifiable against actual reality, no guesswork. ────────────
function LiveClock({ light }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const dateStr = now.toLocaleDateString('en-PH', { weekday:'long', year:'numeric', month:'long', day:'numeric' })
  const timeStr = now.toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:11, color: light ? 'rgba(255,255,255,.85)' : C.muted }}>
      <span>🕒</span>
      <span>{dateStr} · {timeStr}</span>
    </div>
  )
}

function ScreenHome({ setScreen, txns, cfg, students }) {
  const activeStudents = students.filter(s => s.active !== false)
  const monthlyFee     = cfg.rate * cfg.days
  const periodTxns     = txns.filter(t => t.period === CURRENT_PERIOD && t.status === 'confirmed')
  const totalCollected = periodTxns.reduce((a,t) => a + Number(t.amount), 0)
  const totalExpected  = activeStudents.length * monthlyFee
  const paidStudents   = new Set(periodTxns.map(t => t.student_id)).size
  const gcashAmt       = txns.filter(t=>t.method==='GCash').reduce((a,t)=>a+Number(t.amount),0)
  const cashAmt        = txns.filter(t=>t.method==='Cash').reduce((a,t)=>a+Number(t.amount),0)
  const recentTxns     = txns.slice(0, 5)

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:`linear-gradient(160deg,${C.gcash} 0%,${C.gcashDk} 100%)`, padding:'24px 20px 32px', color:C.white }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:11, opacity:.8, letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>BNHS-RSHS School Service</div>
            <div style={{ fontSize:22, fontWeight:900 }}>{cfg.busUnit}</div>
            <div style={{ fontSize:12, opacity:.75, marginTop:2 }}>Leonard M. Garcia</div>
          </div>
          <button onClick={()=>setScreen('settings')} style={{ background:'rgba(255,255,255,.2)', border:'none', borderRadius:10, padding:'8px 14px', color:C.white, fontSize:12, fontWeight:600, cursor:'pointer' }}>⚙</button>
        </div>
        <LiveClock light/>
        <div style={{ background:'rgba(255,255,255,.15)', borderRadius:16, padding:'16px 20px', marginTop:20 }}>
          <div style={{ fontSize:11, opacity:.8, letterSpacing:1, textTransform:'uppercase' }}>{PERIOD_LABELS[CURRENT_PERIOD]} Collection</div>
          <div style={{ fontSize:34, fontWeight:900, marginTop:4 }}>{peso(totalCollected)}</div>
          <div style={{ fontSize:12, opacity:.8, marginTop:2 }}>of {peso(totalExpected)} expected · {paidStudents}/{activeStudents.length} students paid</div>
          <div style={{ background:'rgba(255,255,255,.25)', borderRadius:4, height:6, marginTop:12, overflow:'hidden' }}>
            <div style={{ background:C.amberLt, height:'100%', width:`${Math.min(100, totalExpected > 0 ? totalCollected/totalExpected*100 : 0).toFixed(0)}%`, borderRadius:4, transition:'width .6s' }}/>
          </div>
          <div style={{ fontSize:11, opacity:.8, marginTop:4 }}>{totalExpected > 0 ? (totalCollected/totalExpected*100).toFixed(1) : 0}% collected</div>
        </div>
      </div>

      <div style={{ padding:'16px 16px 0' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
          {[
            { label:'Record Payment', sub:'GCash or Cash',    icon:'💳', grad:[C.gcash,C.gcashDk],     screen:'pay'      },
            { label:'View Students',  sub:'Balances & info',  icon:'👥', grad:['#3D5A99',C.navyMd],    screen:'students' },
            { label:'Transactions',   sub:'Full history',     icon:'📋', grad:['#28C76F',C.green],     screen:'history'  },
            { label:'Expenses',       sub:'Fuel, salary…',   icon:'📊', grad:[C.amberLt,C.amber],     screen:'expenses' },
          ].map(a => (
            <button key={a.label} onClick={()=>setScreen(a.screen)} className="tap-bounce"
              style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:16, padding:'16px 12px', cursor:'pointer', textAlign:'left', display:'flex', gap:12, alignItems:'center', boxShadow:'0 2px 8px rgba(13,27,62,.06)' }}>
              <div style={{ width:48, height:48, background:`linear-gradient(135deg,${a.grad[0]},${a.grad[1]})`, borderRadius:14, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24, flexShrink:0, boxShadow:`0 4px 12px ${a.grad[1]}66` }}>{a.icon}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:800, color:C.text }}>{a.label}</div>
                <div style={{ fontSize:11, color:C.muted }}>{a.sub}</div>
              </div>
            </button>
          ))}
        </div>

        {/* GCash vs Cash split */}
        <div style={{ background:C.white, borderRadius:14, padding:'14px 16px', border:`1px solid ${C.border}`, marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:10 }}>Payment Method Split (All Time)</div>
          <div style={{ display:'flex', height:10, borderRadius:5, overflow:'hidden', marginBottom:8 }}>
            <div style={{ flex:gcashAmt||1, background:`linear-gradient(90deg,${C.gcash},${C.gcashDk})` }}/>
            <div style={{ flex:cashAmt||1,  background:`linear-gradient(90deg,${C.amber},${C.amberLt})` }}/>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12 }}>
            <span>💙 GCash <b>{peso(gcashAmt)}</b></span>
            <span>💵 Cash <b>{peso(cashAmt)}</b></span>
          </div>
        </div>

        {/* Recent */}
        <div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden', marginBottom:16 }}>
          <div style={{ padding:'14px 16px', borderBottom:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between' }}>
            <span style={{ fontSize:13, fontWeight:700, color:C.text }}>Recent Transactions</span>
            <button onClick={()=>setScreen('history')} style={{ background:'none', border:'none', color:C.gcash, fontSize:12, fontWeight:600, cursor:'pointer' }}>See all →</button>
          </div>
          {recentTxns.length === 0 && <div style={{ padding:20, color:C.muted, fontSize:13, textAlign:'center' }}>No transactions yet. Record the first payment!</div>}
          {recentTxns.map((t,i) => {
            const s = t.students || {}
            return (
              <div key={i} style={{ padding:'11px 16px', borderBottom:i<recentTxns.length-1?`1px solid ${C.border}`:'none', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                  <div style={{ width:36, height:36, borderRadius:10, background:t.method==='GCash'?C.gcashLt:C.yellow, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>
                    {t.method==='GCash'?'💙':'💵'}
                  </div>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{s.name || '—'}</div>
                    <div style={{ fontSize:11, color:C.muted }}>{t.method} · {PERIOD_LABELS[t.period] || t.period} · {t.ref}</div>
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:14, fontWeight:700, color:C.green }}>{peso(t.amount)}</div>
                  <div style={{ fontSize:10, color:C.muted }}>{fmtDate(t.date)}</div>
                </div>
              </div>
            )
          })}
        </div>

        <ContactFooter/>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: PAY
// ═══════════════════════════════════════════════════════════
function ScreenPay({ setScreen, onSave, cfg, students, payState, setPayState }) {
  const [step,      setStep]     = useState(payState ? 2 : 1)
  const [studentId, setStudId]   = useState(payState?.student_id || null)
  const [period,    setPeriod]   = useState(CURRENT_PERIOD)
  const [method,    setMethod]   = useState('GCash')
  const [amount,    setAmount]   = useState(payState?.amount ? String(payState.amount) : '')
  const [note,      setNote]     = useState('')
  const [gcashRef,  setGcashRef] = useState('')
  const [countdown, setCountdown]= useState(null)
  const [confirming,setConfirming]=useState(false)
  const intervalRef = useRef(null)

  const monthlyFee = cfg.rate * cfg.days
  const student    = students.find(s => s.id === studentId)

  useEffect(() => {
    if (payState) { setStudId(payState.student_id); setAmount(String(payState.amount || monthlyFee)); setStep(2) }
  }, [])

  const startCountdown = () => {
    setConfirming(true); let secs = 30; setCountdown(secs)
    intervalRef.current = setInterval(() => {
      secs--; setCountdown(secs)
      if (secs <= 0) { clearInterval(intervalRef.current); setConfirming(false); setCountdown(null) }
    }, 1000)
  }

  const confirmPayment = () => {
    clearInterval(intervalRef.current)
    const txn = { id: uid(), student_id: studentId, amount: Number(amount), method, date: today(), period, ref: gcashRef || refid(method), status: 'confirmed', note }
    onSave(txn)
  }

  const Header = ({ title, back }) => (
    <div style={{ background:C.white, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, borderBottom:`1px solid ${C.border}`, position:'sticky', top:0, zIndex:10 }}>
      <button onClick={back} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.navyMd, padding:0 }}>←</button>
      <span style={{ fontSize:16, fontWeight:700, color:C.text }}>{title}</span>
    </div>
  )

  // Step 1: Pick student
  if (step === 1) {
    const filingNumbers = getFilingNumbers(students)
    const sortedStudents = students.filter(s => s.active !== false).sort((a,b) => a.name.localeCompare(b.name))
    return (
    <div style={{ paddingBottom:80 }}>
      <Header title="Select Student" back={()=>setScreen('home')}/>
      <div style={{ padding:'12px 16px' }}>
        <div style={{ fontSize:13, color:C.muted, marginBottom:12 }}>Who is making a payment?</div>
        {sortedStudents.map(s => (
          <button key={s.id} onClick={()=>{ setStudId(s.id); setAmount(String(monthlyFee)); setStep(2) }} className="tap-shrink"
            style={{ display:'flex', justifyContent:'space-between', alignItems:'center', width:'100%', background:C.white, border:`1px solid ${C.border}`, borderRadius:12, padding:'12px 14px', marginBottom:8, cursor:'pointer', textAlign:'left' }}>
            <div style={{ display:'flex', gap:10, alignItems:'center' }}>
              <div style={{ width:26, height:26, borderRadius:8, background:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.amberLt, fontSize:12, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                {filingNumbers[s.id]}
              </div>
              <div>
                <div style={{ fontSize:14, fontWeight:600, color:C.text }}>{s.name}{s.nickname && <span style={{ color:C.muted }}> "{s.nickname}"</span>}</div>
                <div style={{ fontSize:11, color:C.muted }}>Grade {s.grade} · {s.guardian}</div>
              </div>
            </div>
            <div style={{ fontSize:12, color:C.gcash, fontWeight:600 }}>{peso(monthlyFee)} →</div>
          </button>
        ))}
      </div>
    </div>
  )}

  // Step 2: Amount & method
  if (step === 2) return (
    <div style={{ paddingBottom:80 }}>
      <Header title="Payment Details" back={()=>setStep(1)}/>
      <div style={{ padding:'16px' }}>
        <div style={{ background:C.gcashLt, borderRadius:12, padding:'12px 14px', marginBottom:16, border:`1px solid ${C.gcash}33` }}>
          <div style={{ fontSize:12, color:C.gcash, fontWeight:600, marginBottom:2 }}>PAYING FOR</div>
          <div style={{ fontSize:16, fontWeight:700, color:C.navyMd }}>{student?.name}</div>
          <div style={{ fontSize:12, color:C.muted }}>Grade {student?.grade} · {student?.guardian} · {student?.contact}</div>
        </div>

        <label style={lbl}>Pay Period</label>
        <select value={period} onChange={e=>setPeriod(e.target.value)} style={inp}>
          {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </select>

        <label style={lbl}>Amount (₱)</label>
        <div style={{ position:'relative' }}>
          <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)', color:C.gcash, fontWeight:700, fontSize:16 }}>₱</span>
          <input type="number" value={amount} onChange={e=>setAmount(e.target.value)}
            style={{ ...inp, paddingLeft:28, fontSize:20, fontWeight:800, color:C.gcash }}/>
        </div>
        <div style={{ display:'flex', gap:8, marginBottom:16 }}>
          {[monthlyFee, monthlyFee/2, monthlyFee*2].map(v=>(
            <button key={v} onClick={()=>setAmount(String(v))}
              style={{ flex:1, padding:'6px 4px', background:Number(amount)===v?C.gcash:C.gcashLt, color:Number(amount)===v?C.white:C.gcash, border:`1px solid ${C.gcash}44`, borderRadius:8, fontSize:12, fontWeight:600, cursor:'pointer' }}>
              {peso(v)}
            </button>
          ))}
        </div>

        <label style={lbl}>Payment Method</label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
          {['GCash','Cash'].map(m=>(
            <button key={m} onClick={()=>setMethod(m)} className="tap-bounce"
              style={{ padding:16, background:method===m?`linear-gradient(135deg,${m==='GCash'?C.gcash:C.amberLt},${m==='GCash'?C.gcashDk:C.amber})`:C.white, color:method===m?C.white:(m==='GCash'?C.gcash:C.yellowDk), border:`2px solid ${method===m?(m==='GCash'?C.gcash:C.amber):C.border}`, borderRadius:14, fontSize:14, fontWeight:800, cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:6, boxShadow:method===m?`0 4px 14px ${m==='GCash'?C.gcash:C.amber}55`:'none' }}>
              <span style={{ fontSize:28 }}>{m==='GCash'?'💙':'💵'}</span>{m}
            </button>
          ))}
        </div>

        <label style={lbl}>Note (optional)</label>
        <input value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. Partial, advance…" style={inp}/>

        <button onClick={()=>setStep(3)} disabled={!amount || Number(amount)<=0} className="tap-bounce"
          style={{ width:'100%', padding:'15px', background:Number(amount)>0?`linear-gradient(135deg,${C.gcash},${C.gcashDk})`:'#ccc', color:C.white, border:'none', borderRadius:14, fontSize:16, fontWeight:800, cursor:Number(amount)>0?'pointer':'not-allowed', marginTop:8, boxShadow:Number(amount)>0?`0 4px 14px ${C.gcash}55`:'none' }}>
          Continue →
        </button>
      </div>
    </div>
  )

  // Step 3: Confirm
  if (step === 3) return (
    <div style={{ paddingBottom:80 }}>
      <Header title={method==='GCash'?'GCash Payment':'Confirm Cash'} back={()=>setStep(2)}/>
      <div style={{ padding:'16px' }}>
        {method==='GCash' ? (
          <>
            <div style={{ background:C.gcashLt, borderRadius:16, padding:'20px', textAlign:'center', border:`2px solid ${C.gcash}33`, marginBottom:16 }}>
              <div style={{ fontSize:13, color:C.gcash, fontWeight:600, marginBottom:8 }}>SEND GCASH TO</div>
              <div style={{ fontSize:28, fontWeight:900, color:C.gcash }}>{cfg.gcashNum}</div>
              <div style={{ fontSize:14, fontWeight:600, color:C.navyMd, marginTop:4 }}>{cfg.gcashName}</div>
              <div style={{ fontSize:38, fontWeight:900, color:C.gcashDk, margin:'16px 0' }}>{peso(Number(amount))}</div>
              <div style={{ background:C.white, border:`3px solid ${C.gcash}`, borderRadius:12, padding:16, display:'inline-block', margin:'0 auto 12px' }}>
                <div style={{ width:140, height:140, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:6 }}>
                  <div style={{ fontSize:40 }}>📱</div>
                  <div style={{ fontSize:10, color:C.gcash, fontWeight:700 }}>SCAN TO PAY</div>
                  <div style={{ fontSize:9, color:C.muted, textAlign:'center' }}>Add your GCash QR image here in the public/ folder</div>
                </div>
              </div>
              <div style={{ fontSize:11, color:C.muted }}>GCash → Send Money → Scan QR</div>
            </div>
            <label style={lbl}>GCash Reference Number</label>
            <input value={gcashRef} onChange={e=>setGcashRef(e.target.value)} placeholder="e.g. GC-8821451"
              style={{ ...inp, fontFamily:'monospace', fontWeight:700, fontSize:15, letterSpacing:1 }}/>
            <div style={{ fontSize:11, color:C.muted, marginBottom:16 }}>Ask the payer for their GCash receipt reference number.</div>

            <SummaryCard student={student} amount={Number(amount)} period={period} method={method} note={note}/>

            {!confirming
              ? <button onClick={startCountdown} disabled={!gcashRef} className="tap-bounce"
                  style={{ width:'100%', padding:'15px', background:gcashRef?`linear-gradient(135deg,${C.gcash},${C.gcashDk})`:'#ccc', color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:gcashRef?'pointer':'not-allowed', boxShadow:gcashRef?`0 4px 14px ${C.gcash}55`:'none' }}>
                  💙 Confirm GCash Payment
                </button>
              : <button onClick={confirmPayment} className="tap-bounce"
                  style={{ width:'100%', padding:'15px', background:`linear-gradient(135deg,${C.green},#157f3b)`, color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:'pointer' }}>
                  ✅ Payment Received — Confirm ({countdown}s)
                </button>
            }
          </>
        ) : (
          <>
            <div style={{ background:C.yellow, borderRadius:16, padding:'20px', textAlign:'center', border:`2px solid ${C.amberLt}`, marginBottom:16 }}>
              <div style={{ fontSize:13, color:C.yellowDk, fontWeight:600, marginBottom:4 }}>CASH TO COLLECT</div>
              <div style={{ fontSize:42, fontWeight:900, color:C.yellowDk }}>{peso(Number(amount))}</div>
              <div style={{ fontSize:13, color:C.yellowDk, marginTop:4 }}>From: <b>{student?.name}</b></div>
            </div>
            <SummaryCard student={student} amount={Number(amount)} period={period} method={method} note={note}/>
            <button onClick={confirmPayment} className="tap-bounce"
              style={{ width:'100%', padding:'15px', background:`linear-gradient(135deg,${C.amber},${C.amberLt})`, color:C.navy, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:'pointer' }}>
              💵 Confirm Cash Received
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── SUMMARY CARD ─────────────────────────────────────────────
function SummaryCard({ student, amount, period, method, note }) {
  return (
    <div style={{ background:C.white, borderRadius:12, border:`1px solid ${C.border}`, padding:'14px 16px', marginBottom:16 }}>
      <div style={{ fontSize:12, color:C.muted, fontWeight:600, marginBottom:8 }}>PAYMENT SUMMARY</div>
      {[
        { label:'Student', val:student?.name },
        { label:'Grade',   val:`Grade ${student?.grade}` },
        { label:'Period',  val:PERIOD_LABELS[period] || period },
        { label:'Amount',  val:peso(amount), bold:true, color:C.gcash },
        { label:'Method',  val:method },
        ...(note ? [{ label:'Note', val:note }] : []),
      ].map((r,i)=>(
        <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'4px 0', borderBottom:`1px solid ${C.border}` }}>
          <span style={{ color:C.muted }}>{r.label}</span>
          <span style={{ fontWeight:r.bold?800:600, color:r.color||C.text }}>{r.val}</span>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: RECEIPT
// ═══════════════════════════════════════════════════════════
function ScreenReceipt({ setScreen, payState, cfg }) {
  if (!payState) return null
  return (
    <div style={{ paddingBottom:80, minHeight:'100vh', background:C.cream }}>
      <div style={{ padding:'32px 16px 16px', textAlign:'center' }}>
        <div style={{ width:72, height:72, background:C.greenLt, borderRadius:36, display:'flex', alignItems:'center', justifyContent:'center', fontSize:36, margin:'0 auto 12px' }}>✅</div>
        <div style={{ fontSize:22, fontWeight:900, color:C.green }}>Payment Saved!</div>
        <div style={{ fontSize:13, color:C.muted, marginTop:4 }}>Recorded in Supabase database</div>
      </div>
      <div style={{ margin:'0 16px', background:C.white, borderRadius:16, border:`1px solid ${C.border}`, overflow:'hidden' }}>
        <div style={{ background:payState.method==='GCash'?C.gcash:C.amber, padding:'14px 20px', textAlign:'center' }}>
          <div style={{ fontSize:12, color:'rgba(255,255,255,.8)', letterSpacing:1.5, textTransform:'uppercase' }}>Official Receipt</div>
          <div style={{ fontSize:16, fontWeight:800, color:C.white, marginTop:2 }}>{cfg.gcashName}</div>
          <div style={{ fontSize:12, color:'rgba(255,255,255,.8)' }}>{cfg.busUnit}</div>
        </div>
        <div style={{ padding:'16px 20px' }}>
          <div style={{ textAlign:'center', marginBottom:16 }}>
            <div style={{ fontSize:13, color:C.muted }}>AMOUNT PAID</div>
            <div style={{ fontSize:38, fontWeight:900, color:payState.method==='GCash'?C.gcash:C.yellowDk }}>{peso(payState.amount)}</div>
          </div>
          {[
            { label:'Receipt No.', val:payState.id },
            { label:'Reference',   val:payState.ref },
            { label:'Student',     val:payState.studentName || '—' },
            { label:'Period',      val:PERIOD_LABELS[payState.period] || payState.period },
            { label:'Method',      val:payState.method },
            { label:'Date',        val:fmtDate(payState.date) },
            { label:'Status',      val:'✅ CONFIRMED', color:C.green },
            ...(payState.note ? [{ label:'Note', val:payState.note }] : []),
          ].map((r,i)=>(
            <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'7px 0', borderBottom:`1px solid ${C.border}` }}>
              <span style={{ color:C.muted }}>{r.label}</span>
              <span style={{ fontWeight:600, color:r.color||C.text, fontFamily:r.label.includes('No.')||r.label==='Reference'?'monospace':'inherit' }}>{r.val}</span>
            </div>
          ))}
          <div style={{ marginTop:16, padding:'12px', background:C.cream, borderRadius:8, fontSize:11, color:C.muted, textAlign:'center' }}>
            Powered by NEB 1887 · {cfg.gcashName}
          </div>
        </div>
      </div>
      <div style={{ padding:'16px', display:'flex', gap:10 }}>
        <button onClick={()=>setScreen('pay')} style={{ flex:1, padding:'13px', background:payState.method==='GCash'?C.gcash:C.amber, color:payState.method==='GCash'?C.white:C.navy, border:'none', borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer' }}>+ New Payment</button>
        <button onClick={()=>setScreen('home')} style={{ flex:1, padding:'13px', background:C.white, color:C.navy, border:`1px solid ${C.border}`, borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer' }}>🏠 Home</button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: HISTORY
// ═══════════════════════════════════════════════════════════
function ScreenHistory({ setScreen, txns, students, cfg, attendance }) {
  const [filter, setFilter] = useState('All')
  const [search, setSearch] = useState('')
  const [monthlyOpen, setMonthlyOpen] = useState(false)
  const [unpaidOpen, setUnpaidOpen] = useState(false)

  const filtered = txns.filter(t => {
    const name = t.students?.name || students.find(s=>s.id===t.student_id)?.name || ''
    const matchMethod = filter==='All' || t.method===filter || t.period===filter
    const matchSearch = !search || name.toLowerCase().includes(search.toLowerCase()) || (t.ref||'').toLowerCase().includes(search.toLowerCase())
    return matchMethod && matchSearch
  })
  const total = filtered.reduce((a,t)=>a+Number(t.amount),0)
  const gcashTotal = filtered.filter(t=>t.method==='GCash').reduce((a,t)=>a+Number(t.amount),0)
  const cashTotal  = filtered.filter(t=>t.method==='Cash').reduce((a,t)=>a+Number(t.amount),0)

  const currentIdx = PERIODS.indexOf(CURRENT_PERIOD)
  const recentWeeks = PERIODS.slice(Math.max(0, currentIdx - 3), currentIdx + 1)

  // ── MONTHLY ROLLUP (collapsed by default until there's real data) ──
  const periodTotals = {}
  const periodGcash = {}
  const periodCash = {}
  txns.forEach(t => {
    periodTotals[t.period] = (periodTotals[t.period] || 0) + Number(t.amount)
    if (t.method === 'GCash') periodGcash[t.period] = (periodGcash[t.period] || 0) + Number(t.amount)
    if (t.method === 'Cash')  periodCash[t.period]  = (periodCash[t.period]  || 0) + Number(t.amount)
  })
  const monthlyData = getMonthlyTotals(periodTotals).filter(m => m.total > 0)
  const monthlyGcash = getMonthlyTotals(periodGcash)
  const monthlyCash  = getMonthlyTotals(periodCash)

  // ── UNPAID STUDENTS (current week, running balance) ──────────
  const activeStudents = students.filter(s => s.active !== false)
  const unpaidList = activeStudents
    .map(s => ({ student: s, rb: getRunningBalance(s.id, attendance, txns, cfg.rate, CURRENT_PERIOD) }))
    .filter(({ rb }) => rb.status === 'underpaid')
    .sort((a,b) => b.rb.balance - a.rb.balance)

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={()=>setScreen('home')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>Transaction History</span>
        <span style={{ fontSize:12, color:C.amberLt, fontWeight:700 }}>{filtered.length} · {peso(total)}</span>
      </div>

      <div style={{ padding:'12px 16px' }}>
        <button onClick={()=>setScreen('exportPdf')} className="tap-bounce"
          style={{ width:'100%', padding:'12px', background:`linear-gradient(135deg,#3D5A99,${C.navy})`, color:C.white, border:'none', borderRadius:12, fontSize:13, fontWeight:800, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8, marginBottom:12, boxShadow:`0 4px 12px ${C.navy}44` }}>
          🖨️ Export PDF Report
        </button>

        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search student or reference…" style={{ ...inp, marginBottom:10 }}/>
        <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:4 }}>
          {['All','GCash','Cash',...recentWeeks].map(f=>(
            <button key={f} onClick={()=>setFilter(f)}
              style={{ padding:'5px 12px', background:filter===f?C.gcash:C.white, color:filter===f?C.white:C.muted, border:`1px solid ${filter===f?C.gcash:C.border}`, borderRadius:20, fontSize:12, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap', flexShrink:0 }}>
              {PERIOD_LABELS[f] || f}
            </button>
          ))}
        </div>

        {filter !== 'All' && (filter==='GCash'||filter==='Cash') && (
          <div style={{ fontSize:11, color:C.muted, marginTop:8 }}>Showing {filter} payments only · {peso(filter==='GCash'?gcashTotal:cashTotal)}</div>
        )}
      </div>

      <div style={{ padding:'0 16px' }}>
        {filtered.length===0 && <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14 }}>No transactions found.</div>}
        {filtered.map((t,i) => {
          const name = t.students?.name || students.find(s=>s.id===t.student_id)?.name || '—'
          return (
            <div key={i} style={{ background:C.white, borderRadius:12, padding:'12px 14px', marginBottom:8, border:`1px solid ${C.border}`, display:'flex', gap:10, alignItems:'center' }}>
              <div style={{ width:40, height:40, borderRadius:10, background:t.method==='GCash'?C.gcashLt:C.yellow, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
                {t.method==='GCash'?'💙':'💵'}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</div>
                <div style={{ fontSize:11, color:C.muted }}>{PERIOD_LABELS[t.period] || t.period} · <span style={{ fontFamily:'monospace' }}>{t.ref}</span></div>
                {t.note && <div style={{ fontSize:11, color:C.gcash }}>{t.note}</div>}
              </div>
              <div style={{ textAlign:'right', flexShrink:0 }}>
                <div style={{ fontSize:15, fontWeight:800, color:C.green }}>{peso(t.amount)}</div>
                <div style={{ fontSize:10, color:C.muted }}>{fmtDate(t.date)}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* COLLAPSIBLE: UNPAID STUDENTS THIS WEEK */}
      <div style={{ padding:'8px 16px 0' }}>
        <button onClick={()=>setUnpaidOpen(o=>!o)} className="tap-shrink"
          style={{ width:'100%', display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 16px', background:unpaidList.length>0?C.redLt:C.white, border:`1px solid ${unpaidList.length>0?C.red+'44':C.border}`, borderRadius:12, cursor:'pointer' }}>
          <span style={{ fontSize:13, fontWeight:700, color:unpaidList.length>0?C.red:C.text }}>⚠️ Unpaid This Week ({unpaidList.length})</span>
          <span style={{ fontSize:13, color:C.muted, transform:unpaidOpen?'rotate(180deg)':'none', transition:'transform .2s' }}>▾</span>
        </button>
        {unpaidOpen && (
          <div className="tap-pop" style={{ marginTop:8 }}>
            {unpaidList.length === 0 && (
              <div style={{ textAlign:'center', color:C.green, padding:20, fontSize:13, background:C.greenLt, borderRadius:12, fontWeight:700 }}>
                ✅ Everyone is paid up for {PERIOD_LABELS[CURRENT_PERIOD]}!
              </div>
            )}
            {unpaidList.map(({ student, rb }, i) => (
              <div key={i} style={{ background:C.white, borderRadius:12, padding:'11px 14px', marginBottom:8, border:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{student.name}{student.nickname && <span style={{ color:C.muted, fontWeight:500 }}> "{student.nickname}"</span>}</div>
                  <div style={{ fontSize:11, color:C.muted }}>{student.guardian} · {student.contact}</div>
                </div>
                <div style={{ fontSize:14, fontWeight:800, color:C.red }}>{peso(rb.balance)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* COLLAPSIBLE MONTHLY TOTALS — now with payment mode breakdown */}
      <div style={{ padding:'8px 16px 0' }}>
        <button onClick={()=>setMonthlyOpen(o=>!o)} className="tap-shrink"
          style={{ width:'100%', display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 16px', background:C.white, border:`1px solid ${C.border}`, borderRadius:12, cursor:'pointer' }}>
          <span style={{ fontSize:13, fontWeight:700, color:C.text }}>🗂 Monthly Totals & Payment Mode</span>
          <span style={{ fontSize:13, color:C.muted, transform:monthlyOpen?'rotate(180deg)':'none', transition:'transform .2s' }}>▾</span>
        </button>
        {monthlyOpen && (
          <div className="tap-pop" style={{ marginTop:8 }}>
            {monthlyData.length === 0 && (
              <div style={{ textAlign:'center', color:C.muted, padding:24, fontSize:13, background:C.white, borderRadius:12, border:`1px solid ${C.border}` }}>
                No monthly data yet — totals will appear here once payments are recorded.
              </div>
            )}
            {monthlyData.map((m,i) => {
              const gc = monthlyGcash.find(x=>x.monthKey===m.monthKey)?.total || 0
              const cs = monthlyCash.find(x=>x.monthKey===m.monthKey)?.total || 0
              return (
                <div key={i} style={{ background:C.white, borderRadius:14, padding:'14px 16px', marginBottom:8, border:`1px solid ${C.border}`, borderLeft:`4px solid ${C.gcash}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                    <div>
                      <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{m.monthLabel}</div>
                      <div style={{ fontSize:11, color:C.muted }}>{m.weeks.length} week{m.weeks.length!==1?'s':''} billed</div>
                    </div>
                    <div style={{ fontSize:18, fontWeight:900, color:C.green }}>{peso(m.total)}</div>
                  </div>
                  <div style={{ display:'flex', height:8, borderRadius:4, overflow:'hidden', marginBottom:6 }}>
                    <div style={{ flex:gc||0.0001, background:`linear-gradient(90deg,${C.gcash},${C.gcashDk})` }}/>
                    <div style={{ flex:cs||0.0001, background:`linear-gradient(90deg,${C.amber},${C.amberLt})` }}/>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:11 }}>
                    <span>💙 GCash: <b>{peso(gc)}</b></span>
                    <span>💵 Cash: <b>{peso(cs)}</b></span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: EXPORT PDF — pick a range, export transactions or expenses
// ═══════════════════════════════════════════════════════════
function ScreenExportPdf({ setScreen, txns, students, expenses, cfg }) {
  const [reportType, setReportType] = useState('transactions') // 'transactions' | 'expenses'
  const [startPeriod, setStartPeriod] = useState(PERIODS[0])
  const [endPeriod, setEndPeriod] = useState(CURRENT_PERIOD)
  const [generating, setGenerating] = useState(false)

  const startIdx = PERIODS.indexOf(startPeriod)
  const endIdx = PERIODS.indexOf(endPeriod)
  const validRange = startIdx <= endIdx
  const rangeWeeks = validRange ? PERIODS.slice(startIdx, endIdx + 1) : []

  const txnsInRange = txns.filter(t => rangeWeeks.includes(t.period))
  const expensesInRange = expenses.filter(e => rangeWeeks.includes(e.period))

  const handleExport = () => {
    setGenerating(true)
    try {
      if (reportType === 'transactions') {
        exportTransactionsPDF({
          txns: txnsInRange,
          students,
          periodLabels: PERIOD_LABELS,
          startLabel: PERIOD_LABELS[startPeriod],
          endLabel: PERIOD_LABELS[endPeriod],
          busUnit: cfg.busUnit,
          gcashName: cfg.gcashName,
        })
      } else {
        exportExpensesPDF({
          expenses: expensesInRange,
          periodLabels: PERIOD_LABELS,
          startLabel: PERIOD_LABELS[startPeriod],
          endLabel: PERIOD_LABELS[endPeriod],
          busUnit: cfg.busUnit,
          gcashName: cfg.gcashName,
        })
      }
    } finally {
      setGenerating(false)
    }
  }

  const previewTotal = reportType === 'transactions'
    ? txnsInRange.reduce((a,t)=>a+Number(t.amount),0)
    : expensesInRange.reduce((a,e)=>a+Number(e.amount),0)
  const previewCount = reportType === 'transactions' ? txnsInRange.length : expensesInRange.length

  return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={()=>setScreen('history')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white }}>Export PDF Report</span>
      </div>

      <div style={{ padding:16 }}>
        <label style={lbl}>Report Type</label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
          {[{k:'transactions',l:'💳 Transactions',c:C.gcash},{k:'expenses',l:'📊 Expenses',c:C.amber}].map(o => (
            <button key={o.k} onClick={()=>setReportType(o.k)} className="tap-bounce"
              style={{ padding:14, background:reportType===o.k?`linear-gradient(135deg,${o.c},${o.c}dd)`:C.white, color:reportType===o.k?C.white:C.muted, border:`2px solid ${reportType===o.k?o.c:C.border}`, borderRadius:12, fontSize:13, fontWeight:800, cursor:'pointer' }}>
              {o.l}
            </button>
          ))}
        </div>

        <label style={lbl}>From (Start Week)</label>
        <select value={startPeriod} onChange={e=>setStartPeriod(e.target.value)} style={inp}>
          {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </select>

        <label style={lbl}>To (End Week)</label>
        <select value={endPeriod} onChange={e=>setEndPeriod(e.target.value)} style={inp}>
          {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </select>

        {!validRange && (
          <div style={{ background:C.redLt, color:C.red, padding:'10px 14px', borderRadius:10, fontSize:12, fontWeight:600, marginTop:8 }}>
            ⚠️ "From" week must come before or equal to "To" week.
          </div>
        )}

        {validRange && (
          <div style={{ background:C.gcashLt, borderRadius:14, padding:'16px', marginTop:16, marginBottom:16 }}>
            <div style={{ fontSize:12, color:C.gcash, fontWeight:700, marginBottom:8 }}>REPORT PREVIEW</div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:4 }}>
              <span style={{ color:C.muted }}>Range</span>
              <span style={{ fontWeight:700, color:C.navyMd }}>{rangeWeeks.length} week{rangeWeeks.length!==1?'s':''}</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:4 }}>
              <span style={{ color:C.muted }}>{reportType === 'transactions' ? 'Transactions' : 'Expense entries'}</span>
              <span style={{ fontWeight:700, color:C.navyMd }}>{previewCount}</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, marginTop:8, paddingTop:8, borderTop:`1px solid ${C.gcash}33` }}>
              <span style={{ fontWeight:700, color:C.navyMd }}>Total</span>
              <span style={{ fontWeight:900, color:C.gcashDk }}>{peso(previewTotal)}</span>
            </div>
          </div>
        )}

        <button onClick={handleExport} disabled={!validRange || generating || previewCount===0} className="tap-bounce"
          style={{ width:'100%', padding:16, background:(!validRange||previewCount===0)?'#ccc':`linear-gradient(135deg,#3D5A99,${C.navy})`, color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:(!validRange||previewCount===0)?'not-allowed':'pointer', boxShadow:(!validRange||previewCount===0)?'none':`0 4px 14px ${C.navy}44` }}>
          {generating ? 'Generating…' : '🖨️ Download PDF Report'}
        </button>
        {previewCount === 0 && validRange && (
          <div style={{ textAlign:'center', color:C.muted, fontSize:12, marginTop:10 }}>No {reportType} found in this range yet.</div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: ANALYTICS — income vs expenses, net & margin, weekly/monthly
// ═══════════════════════════════════════════════════════════
function ScreenAnalytics({ setScreen, txns, expenses }) {
  const [view, setView] = useState('monthly') // 'weekly' | 'monthly'

  // ── WEEKLY FIGURES ────────────────────────────────────────────
  const weeklyRows = PERIODS
    .map(p => {
      const income   = txns.filter(t => t.period === p && t.status === 'confirmed').reduce((a,t)=>a+Number(t.amount),0)
      const expense   = expenses.filter(e => e.period === p).reduce((a,e)=>a+Number(e.amount),0)
      const net       = income - expense
      const margin    = income > 0 ? (net / income * 100) : null
      return { period:p, label:PERIOD_LABELS[p], income, expense, net, margin }
    })
    .filter(r => r.income > 0 || r.expense > 0)

  // ── MONTHLY FIGURES (rolled up from weekly) ───────────────────
  const incomeByPeriod = {}
  const expenseByPeriod = {}
  txns.forEach(t => { incomeByPeriod[t.period] = (incomeByPeriod[t.period]||0) + Number(t.amount) })
  expenses.forEach(e => { expenseByPeriod[e.period] = (expenseByPeriod[e.period]||0) + Number(e.amount) })

  const monthlyIncome  = getMonthlyTotals(incomeByPeriod)
  const monthlyExpense = getMonthlyTotals(expenseByPeriod)
  const monthlyRows = monthlyIncome.map(mi => {
    const me = monthlyExpense.find(x => x.monthKey === mi.monthKey)
    const expense = me ? me.total : 0
    const net = mi.total - expense
    const margin = mi.total > 0 ? (net / mi.total * 100) : null
    return { monthKey:mi.monthKey, label:mi.monthLabel, income:mi.total, expense, net, margin }
  }).filter(r => r.income > 0 || r.expense > 0)

  // ── ALL-TIME SUMMARY ───────────────────────────────────────────
  const totalIncome  = txns.filter(t=>t.status==='confirmed').reduce((a,t)=>a+Number(t.amount),0)
  const totalExpense = expenses.reduce((a,e)=>a+Number(e.amount),0)
  const totalNet     = totalIncome - totalExpense
  const totalMargin  = totalIncome > 0 ? (totalNet / totalIncome * 100) : null

  const rows = view === 'weekly' ? weeklyRows : monthlyRows

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:`linear-gradient(160deg,#9B59B6,#6C3483)`, padding:'22px 20px 26px', color:C.white }}>
        <div style={{ fontSize:11, opacity:.8, letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Analytics</div>
        <div style={{ fontSize:20, fontWeight:900 }}>Income vs Expenses</div>
        <div style={{ background:'rgba(255,255,255,.15)', borderRadius:16, padding:'16px 20px', marginTop:16 }}>
          <div style={{ fontSize:11, opacity:.8, letterSpacing:1, textTransform:'uppercase' }}>All-Time Net Income</div>
          <div style={{ fontSize:32, fontWeight:900, marginTop:4 }}>{peso(totalNet)}</div>
          <div style={{ fontSize:12, opacity:.85, marginTop:4 }}>
            {peso(totalIncome)} collected − {peso(totalExpense)} expenses
            {totalMargin !== null && ` · ${totalMargin.toFixed(1)}% margin`}
          </div>
        </div>
      </div>

      <div style={{ padding:16 }}>
        <div style={{ display:'flex', gap:8, marginBottom:16 }}>
          {[{k:'weekly',l:'📅 Weekly'},{k:'monthly',l:'🗂 Monthly'}].map(o => (
            <button key={o.k} onClick={()=>setView(o.k)} className="tap-bounce"
              style={{ flex:1, padding:'10px', borderRadius:12, cursor:'pointer', fontSize:13, fontWeight:800,
                background: view===o.k ? `linear-gradient(135deg,#9B59B6,#6C3483)` : C.white,
                color: view===o.k ? C.white : C.muted,
                boxShadow: view===o.k ? `0 4px 14px #9B59B644` : `0 1px 3px rgba(0,0,0,.06)`,
                border: view===o.k ? 'none' : `1px solid ${C.border}` }}>
              {o.l}
            </button>
          ))}
        </div>

        {rows.length === 0 && (
          <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14, background:C.white, borderRadius:12, border:`1px solid ${C.border}` }}>
            No data yet — figures will appear once payments and expenses are recorded.
          </div>
        )}

        {rows.map((r,i) => (
          <div key={i} style={{ background:C.white, borderRadius:14, padding:'14px 16px', marginBottom:10, border:`1px solid ${C.border}`, borderLeft:`4px solid ${r.net>=0?C.green:C.red}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
              <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{r.label}</div>
              <div style={{ fontSize:18, fontWeight:900, color:r.net>=0?C.green:C.red }}>{peso(r.net)}</div>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:C.muted, marginBottom:6 }}>
              <span>💰 Income: <b style={{ color:C.green }}>{peso(r.income)}</b></span>
              <span>📉 Expenses: <b style={{ color:C.red }}>{peso(r.expense)}</b></span>
            </div>
            {/* Income vs expense bar */}
            <div style={{ display:'flex', height:8, borderRadius:4, overflow:'hidden', marginBottom:6 }}>
              <div style={{ flex:r.income||0.0001, background:`linear-gradient(90deg,#28C76F,${C.green})` }}/>
              <div style={{ flex:r.expense||0.0001, background:`linear-gradient(90deg,#FF8A80,${C.red})` }}/>
            </div>
            {r.margin !== null && (
              <div style={{ textAlign:'right', fontSize:11, fontWeight:700, color:r.margin>=0?C.green:C.red }}>
                {r.margin.toFixed(1)}% margin
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: STUDENTS
// ═══════════════════════════════════════════════════════════
function ScreenStudents({ setScreen, txns, cfg, students, setPayState, attendance, setSelectedStudentId }) {
  const [search, setSearch] = useState('')
  const [period, setPeriod] = useState(CURRENT_PERIOD)
  const activeStudents = students.filter(s => s.active !== false)
  const filingNumbers = getFilingNumbers(students)

  const list = activeStudents
    .filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={()=>setScreen('home')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white }}>Students ({activeStudents.length})</span>
      </div>
      <div style={{ padding:'12px 16px' }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search student…" style={{ ...inp, marginBottom:10 }}/>

        <WeekNavigator period={period} setPeriod={setPeriod} label="Viewing Balances For"/>
        <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>Tap a student for full details. Numbered alphabetically for filing.</div>
      </div>
      <div style={{ padding:'0 16px' }}>
        {list.map(s => {
          const rb = getRunningBalance(s.id, attendance, txns, cfg.rate, period)
          const { fee, carriedIn, amountDue, paid, balance, status, days } = rb
          return (
            <div key={s.id} onClick={()=>{ setSelectedStudentId(s.id); setScreen('studentDetail') }} className="tap-shrink"
              style={{ background:C.white, borderRadius:12, padding:'13px 14px', marginBottom:8, border:`1px solid ${C.border}`, borderLeft:`4px solid ${status==='paid'?C.green:status==='underpaid'?C.red:status==='overpaid'?C.amber:C.border}`, cursor:'pointer' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
                <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                  <div style={{ width:26, height:26, borderRadius:8, background:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.amberLt, fontSize:12, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1 }}>
                    {filingNumbers[s.id]}
                  </div>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{s.name}{s.nickname && <span style={{ color:C.muted, fontWeight:500 }}> "{s.nickname}"</span>}</div>
                    <div style={{ fontSize:11, color:C.muted }}>Grade {s.grade} · {s.guardian} · {s.contact}</div>
                  </div>
                </div>
                <span style={{ background:C.navy, color:C.amberLt, fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:10 }}>GR.{s.grade}</span>
              </div>

              {/* Fee breakdown */}
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:C.muted, marginBottom:2 }}>
                <span>{days} days × {peso(cfg.rate)} = {peso(fee)}</span>
                {carriedIn !== 0 && <span style={{ color:carriedIn>0?C.red:C.amber, fontWeight:700 }}>{carriedIn>0?'+ '+peso(carriedIn)+' owed':'− '+peso(Math.abs(carriedIn))+' credit'}</span>}
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:6 }}>
                <span style={{ color:C.muted }}>Amount due: <b style={{ color:C.text }}>{peso(amountDue)}</b></span>
                <span style={{ color:C.muted }}>Paid: <b style={{ color:C.green }}>{peso(paid)}</b></span>
              </div>

              {/* Status badge */}
              {status === 'paid' && (
                <div style={{ display:'flex', alignItems:'center', gap:6, background:C.greenLt, color:C.green, padding:'6px 10px', borderRadius:8, fontSize:12, fontWeight:800, marginBottom:10 }}>
                  ✅ FULLY PAID — Current, no forwarded balance
                </div>
              )}
              {status === 'underpaid' && (
                <div style={{ display:'flex', alignItems:'center', gap:6, background:C.redLt, color:C.red, padding:'6px 10px', borderRadius:8, fontSize:12, fontWeight:800, marginBottom:10 }}>
                  ⚠️ OWES {peso(balance)} — will carry to next week
                </div>
              )}
              {status === 'overpaid' && (
                <div style={{ display:'flex', alignItems:'center', gap:6, background:'#FFF4DD', color:'#A66A00', padding:'6px 10px', borderRadius:8, fontSize:12, fontWeight:800, marginBottom:10 }}>
                  💰 OVERPAID by {peso(Math.abs(balance))} — credit carries to next week
                </div>
              )}
              {status === 'unbilled' && (
                <div style={{ display:'flex', alignItems:'center', gap:6, background:C.cream, color:C.muted, padding:'6px 10px', borderRadius:8, fontSize:12, fontWeight:700, marginBottom:10 }}>
                  ⏳ No attendance logged yet for this week
                </div>
              )}

              <div style={{ background:C.border, borderRadius:4, height:5, overflow:'hidden', marginBottom:10 }}>
                <div style={{ background:status==='paid'?C.green:status==='overpaid'?C.amber:C.gcash, height:'100%', width:`${amountDue>0?Math.min(100,(paid/amountDue*100)):(paid>0?100:0)}%`, borderRadius:4 }}/>
              </div>

              <button onClick={(e)=>{ e.stopPropagation(); setPayState({ student_id:s.id, amount: balance>0?balance:fee, period }); setScreen('pay') }} className="tap-bounce"
                style={{ width:'100%', padding:'10px', background:balance>0?`linear-gradient(135deg,${C.gcash},${C.gcashDk})`:'#e8f5ee', color:balance>0?C.white:C.green, border:'none', borderRadius:10, fontSize:13, fontWeight:800, cursor:'pointer', boxShadow:balance>0?`0 3px 10px ${C.gcash}44`:'none' }}>
                {balance>0?'💙 Pay '+peso(balance):'✅ Add Another Payment'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: STUDENT DETAIL — full profile for one student
// ═══════════════════════════════════════════════════════════
function ScreenStudentDetail({ setScreen, studentId, students, txns, cfg, attendance, setPayState }) {
  const student = students.find(s => s.id === studentId)
  if (!student) {
    return (
      <div style={{ padding:40, textAlign:'center' }}>
        <div style={{ color:C.muted, marginBottom:16 }}>Student not found.</div>
        <button onClick={()=>setScreen('students')} style={{ padding:'10px 20px', background:C.navy, color:C.white, border:'none', borderRadius:10, cursor:'pointer' }}>← Back to Students</button>
      </div>
    )
  }

  const filingNumbers = getFilingNumbers(students)
  const rb = getRunningBalance(student.id, attendance, txns, cfg.rate, CURRENT_PERIOD)
  const { fee, carriedIn, amountDue, paid, balance, status, days } = rb

  const myTxns = txns
    .filter(t => t.student_id === student.id && t.status === 'confirmed')
    .sort((a,b) => new Date(b.date) - new Date(a.date))
  const totalPaidAllTime = myTxns.reduce((a,t) => a + Number(t.amount), 0)

  return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, position:'sticky', top:0, zIndex:10 }}>
        <button onClick={()=>setScreen('students')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>Student Profile</span>
      </div>

      {/* PROFILE HEADER */}
      <div style={{ background:`linear-gradient(160deg,${C.gcash} 0%,${C.gcashDk} 100%)`, padding:'22px 20px 26px', color:C.white }}>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <div style={{ width:52, height:52, borderRadius:16, background:'rgba(255,255,255,.2)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, fontWeight:900, flexShrink:0 }}>
            #{filingNumbers[student.id]}
          </div>
          <div>
            <div style={{ fontSize:19, fontWeight:900 }}>{student.name}</div>
            {student.nickname && <div style={{ fontSize:13, opacity:.85 }}>"{student.nickname}"</div>}
            <div style={{ fontSize:12, opacity:.8, marginTop:4 }}>Grade {student.grade} · {cfg.busUnit}</div>
          </div>
        </div>
      </div>

      <div style={{ padding:16 }}>
        {/* CONTACT INFO */}
        <div style={{ background:C.white, borderRadius:14, padding:'14px 16px', border:`1px solid ${C.border}`, marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:700, color:C.muted, letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>Contact Info</div>
          {[
            { label:'Guardian',  val:student.guardian, icon:'👤' },
            { label:'Contact',   val:student.contact,  icon:'📞', tel:true },
            { label:'Address',   val:student.address,  icon:'📍' },
            { label:'Parent Login', val:student.parent_email, icon:'🔐' },
          ].filter(r => r.val).map((r,i) => (
            <div key={i} style={{ display:'flex', gap:10, alignItems:'center', padding:'8px 0', borderTop:i>0?`1px solid ${C.border}`:'none' }}>
              <span style={{ fontSize:16 }}>{r.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase', letterSpacing:.5 }}>{r.label}</div>
                <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{r.val}</div>
              </div>
              {r.tel && (
                <a href={`tel:${r.val}`} className="tap-shrink" style={{ background:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, padding:'7px 14px', borderRadius:20, fontSize:12, fontWeight:700, textDecoration:'none' }}>📞 Call</a>
              )}
            </div>
          ))}
        </div>

        {/* CURRENT BALANCE */}
        <div style={{ background:C.white, borderRadius:14, padding:'14px 16px', border:`1px solid ${C.border}`, marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:700, color:C.muted, letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>{PERIOD_LABELS[CURRENT_PERIOD]} Balance</div>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:C.muted, marginBottom:4 }}>
            <span>{days} days × {peso(cfg.rate)} = {peso(fee)}</span>
            {carriedIn !== 0 && <span style={{ color:carriedIn>0?C.red:C.amber, fontWeight:700 }}>{carriedIn>0?'+ '+peso(carriedIn)+' owed':'− '+peso(Math.abs(carriedIn))+' credit'}</span>}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:10 }}>
            <span style={{ color:C.muted }}>Due: <b style={{ color:C.text }}>{peso(amountDue)}</b></span>
            <span style={{ color:C.muted }}>Paid: <b style={{ color:C.green }}>{peso(paid)}</b></span>
          </div>
          {status === 'paid' && <div style={{ background:C.greenLt, color:C.green, padding:'8px 12px', borderRadius:8, fontSize:12, fontWeight:800 }}>✅ FULLY PAID — Current, no forwarded balance</div>}
          {status === 'underpaid' && <div style={{ background:C.redLt, color:C.red, padding:'8px 12px', borderRadius:8, fontSize:12, fontWeight:800 }}>⚠️ OWES {peso(balance)} — carries to next week</div>}
          {status === 'overpaid' && <div style={{ background:'#FFF4DD', color:'#A66A00', padding:'8px 12px', borderRadius:8, fontSize:12, fontWeight:800 }}>💰 OVERPAID by {peso(Math.abs(balance))} — credit carries forward</div>}
          {status === 'unbilled' && <div style={{ background:C.cream, color:C.muted, padding:'8px 12px', borderRadius:8, fontSize:12, fontWeight:700 }}>⏳ No attendance logged yet this week</div>}
        </div>

        {/* QUICK ACTIONS */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
          <button onClick={()=>{ setPayState({ student_id:student.id, amount: balance>0?balance:fee, period:CURRENT_PERIOD }); setScreen('pay') }} className="tap-bounce"
            style={{ padding:14, background:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, border:'none', borderRadius:12, fontSize:13, fontWeight:800, cursor:'pointer', boxShadow:`0 4px 12px ${C.gcash}44` }}>
            💙 Record Payment
          </button>
          <button onClick={()=>setScreen('manage')} className="tap-bounce"
            style={{ padding:14, background:`linear-gradient(135deg,#3D5A99,${C.navy})`, color:C.white, border:'none', borderRadius:12, fontSize:13, fontWeight:800, cursor:'pointer', boxShadow:`0 4px 12px ${C.navy}44` }}>
            ✏️ Edit Info
          </button>
        </div>
        <button onClick={()=>setScreen('studentStatement')} className="tap-bounce"
          style={{ width:'100%', padding:14, background:`linear-gradient(135deg,#5FE39A,${C.green})`, color:C.white, border:'none', borderRadius:12, fontSize:13, fontWeight:800, cursor:'pointer', boxShadow:`0 4px 12px ${C.green}44`, marginBottom:16, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          🧾 View Statement (Share / Screenshot)
        </button>

        {/* TOTAL PAID ALL TIME */}
        <div style={{ background:C.navy, borderRadius:14, padding:'14px 16px', display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <span style={{ color:C.white, fontSize:13, fontWeight:600 }}>Total Paid (All Time)</span>
          <span style={{ color:C.amberLt, fontSize:20, fontWeight:900 }}>{peso(totalPaidAllTime)}</span>
        </div>

        {/* PAYMENT HISTORY */}
        <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:10 }}>Payment History ({myTxns.length})</div>
        {myTxns.length === 0 && <div style={{ textAlign:'center', color:C.muted, padding:24, fontSize:13, background:C.white, borderRadius:12, border:`1px solid ${C.border}` }}>No payments recorded yet for this student.</div>}
        {myTxns.map((t,i) => (
          <div key={i} style={{ background:C.white, borderRadius:12, padding:'11px 14px', marginBottom:8, border:`1px solid ${C.border}`, display:'flex', gap:10, alignItems:'center' }}>
            <div style={{ width:36, height:36, borderRadius:10, background:t.method==='GCash'?C.gcashLt:C.yellow, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0 }}>
              {t.method==='GCash'?'💙':'💵'}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.text }}>{PERIOD_LABELS[t.period] || t.period}</div>
              <div style={{ fontSize:11, color:C.muted, fontFamily:'monospace' }}>{t.ref}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:14, fontWeight:800, color:C.green }}>{peso(t.amount)}</div>
              <div style={{ fontSize:10, color:C.muted }}>{fmtDate(t.date)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: STUDENT STATEMENT (admin route wrapper)
// ═══════════════════════════════════════════════════════════
function ScreenStudentStatement({ setScreen, studentId, students, txns, attendance, cfg }) {
  const student = students.find(s => s.id === studentId)
  if (!student) {
    return (
      <div style={{ padding:40, textAlign:'center' }}>
        <div style={{ color:C.muted, marginBottom:16 }}>Student not found.</div>
        <button onClick={()=>setScreen('students')} style={{ padding:'10px 20px', background:C.navy, color:C.white, border:'none', borderRadius:10, cursor:'pointer' }}>← Back to Students</button>
      </div>
    )
  }
  return <StudentStatementView student={student} txns={txns} attendance={attendance} cfg={cfg} onBack={()=>setScreen('studentDetail')}/>
}

// ─── SHARED STATEMENT VIEW — screenshot/share-friendly, weekly & monthly ────
function StudentStatementView({ student, txns, attendance, cfg, onBack }) {
  const [view, setView] = useState('weekly') // 'weekly' | 'monthly'
  const [copied, setCopied] = useState(false)

  const myTxns = txns.filter(t => t.student_id === student.id && t.status === 'confirmed')

  // ── WEEKLY ROWS ───────────────────────────────────────────────
  const weeklyRows = []
  let carry = 0
  for (const w of WEEKS) {
    const rec  = attendance.find(a => a.student_id === student.id && a.period === w.key)
    const days = rec ? rec.days_present : 0
    const fee  = days * cfg.rate
    const weekTxns = myTxns.filter(t => t.period === w.key)
    const paid = weekTxns.reduce((a,t)=>a+Number(t.amount),0)
    const amountDue = fee + carry
    const balance = amountDue - paid
    if (fee > 0 || paid > 0 || carry !== 0) {
      weeklyRows.push({ period:w.key, label:w.label, range:w.dateRange, days, fee, carriedIn:carry, amountDue, paid, balance, txns:weekTxns })
    }
    carry = balance
  }
  const visibleWeekly = weeklyRows.slice().reverse() // most recent first

  // ── MONTHLY ROWS ─────────────────────────────────────────────
  const monthMap = {}
  weeklyRows.forEach(r => {
    const w = WEEKS.find(x => x.key === r.period)
    if (!w) return
    monthMap[w.monthKey] = monthMap[w.monthKey] || { monthKey:w.monthKey, monthLabel:w.monthLabel, fee:0, paid:0, txns:[] }
    monthMap[w.monthKey].fee += r.fee
    monthMap[w.monthKey].paid += r.paid
    monthMap[w.monthKey].txns.push(...r.txns)
  })
  const monthlyRows = Object.values(monthMap).reverse()

  const totalPaidAllTime = myTxns.reduce((a,t)=>a+Number(t.amount),0)
  const latestBalance = weeklyRows.length ? weeklyRows[weeklyRows.length-1].balance : 0

  const handleCopy = () => {
    const lines = [`${cfg.busUnit} — Statement for ${student.name}`, '']
    const rows = view === 'weekly' ? visibleWeekly : monthlyRows
    rows.forEach(r => {
      const label = view === 'weekly' ? r.label : r.monthLabel
      const due   = view === 'weekly' ? r.amountDue : r.fee
      lines.push(`${label}: Due ${peso(due)} — Paid ${peso(r.paid)}`)
    })
    lines.push('', `Total Paid (All Time): ${peso(totalPaidAllTime)}`, `Current Balance: ${peso(latestBalance)}`)
    navigator.clipboard?.writeText(lines.join('\n'))
    setCopied(true)
    setTimeout(()=>setCopied(false), 2000)
  }

  return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, position:'sticky', top:0, zIndex:10 }}>
        <button onClick={onBack} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>Statement</span>
      </div>

      {/* SCREENSHOT-FRIENDLY CARD */}
      <div style={{ padding:16 }}>
        <div style={{ background:`linear-gradient(160deg,${C.gcash},${C.gcashDk})`, borderRadius:18, padding:'20px', color:C.white, marginBottom:16 }}>
          <div style={{ fontSize:11, opacity:.8, letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>{cfg.busUnit} · Statement</div>
          <div style={{ fontSize:19, fontWeight:900 }}>{student.name}{student.nickname && ` "${student.nickname}"`}</div>
          <div style={{ fontSize:12, opacity:.8, marginTop:2 }}>Grade {student.grade}</div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:16, paddingTop:16, borderTop:'1px solid rgba(255,255,255,.25)' }}>
            <div>
              <div style={{ fontSize:11, opacity:.8 }}>Total Paid (All Time)</div>
              <div style={{ fontSize:20, fontWeight:900 }}>{peso(totalPaidAllTime)}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:11, opacity:.8 }}>Current Balance</div>
              <div style={{ fontSize:20, fontWeight:900, color:latestBalance>0?'#FFD9D9':latestBalance<0?C.amberLt:'#D9FFE8' }}>{peso(latestBalance)}</div>
            </div>
          </div>
        </div>

        {/* SHARE / COPY ACTIONS — GCash-style row of options */}
        <div style={{ display:'flex', gap:10, marginBottom:16 }}>
          <button onClick={handleCopy} className="tap-bounce"
            style={{ flex:1, padding:12, background:copied?C.green:C.white, color:copied?C.white:C.navy, border:`1px solid ${copied?C.green:C.border}`, borderRadius:12, fontSize:12, fontWeight:700, cursor:'pointer' }}>
            {copied ? '✅ Copied!' : '📋 Copy as Text'}
          </button>
          <button onClick={()=>window.print()} className="tap-bounce"
            style={{ flex:1, padding:12, background:C.white, color:C.navy, border:`1px solid ${C.border}`, borderRadius:12, fontSize:12, fontWeight:700, cursor:'pointer' }}>
            🖨️ Print / Save
          </button>
        </div>
        <div style={{ fontSize:11, color:C.muted, textAlign:'center', marginBottom:16 }}>
          💡 Tip: you can also just take a screenshot of this page to send directly.
        </div>

        {/* WEEKLY / MONTHLY TOGGLE */}
        <div style={{ display:'flex', gap:8, marginBottom:14 }}>
          {[{k:'weekly',l:'📅 Weekly'},{k:'monthly',l:'🗂 Monthly'}].map(o => (
            <button key={o.k} onClick={()=>setView(o.k)} className="tap-bounce"
              style={{ flex:1, padding:'10px', borderRadius:12, cursor:'pointer', fontSize:13, fontWeight:800,
                background: view===o.k ? `linear-gradient(135deg,${C.gcash},${C.gcashDk})` : C.white,
                color: view===o.k ? C.white : C.muted,
                boxShadow: view===o.k ? `0 4px 14px ${C.gcash}44` : `0 1px 3px rgba(0,0,0,.06)`,
                border: view===o.k ? 'none' : `1px solid ${C.border}` }}>
              {o.l}
            </button>
          ))}
        </div>

        {view === 'weekly' ? (
          <>
            {visibleWeekly.length === 0 && (
              <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13, background:C.white, borderRadius:12, border:`1px solid ${C.border}` }}>No billing history yet.</div>
            )}
            {visibleWeekly.map((r,i) => (
              <div key={i} style={{ background:C.white, borderRadius:14, padding:'14px 16px', marginBottom:10, border:`1px solid ${C.border}`, borderLeft:`4px solid ${r.balance===0?C.green:r.balance>0?C.red:C.amber}` }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:800, color:C.text }}>{r.label}</div>
                    <div style={{ fontSize:10, color:C.muted }}>{r.range}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:15, fontWeight:900, color:r.balance===0?C.green:r.balance>0?C.red:C.amber }}>
                      {r.balance===0?'PAID':peso(Math.abs(r.balance))}
                    </div>
                    <div style={{ fontSize:10, color:C.muted }}>{r.balance>0?'owed':r.balance<0?'credit':''}</div>
                  </div>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:C.muted, marginBottom:8 }}>
                  <span>{r.days} days × {peso(cfg.rate)} = {peso(r.fee)}</span>
                  <span>Due {peso(r.amountDue)} · Paid {peso(r.paid)}</span>
                </div>
                {r.txns.length > 0 && (
                  <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:8, marginTop:4 }}>
                    {r.txns.map((t,j) => (
                      <div key={j} style={{ display:'flex', justifyContent:'space-between', fontSize:11, padding:'3px 0' }}>
                        <span style={{ color:C.muted }}>{t.method==='GCash'?'💙':'💵'} {t.ref} · {fmtDate(t.date)}</span>
                        <span style={{ fontWeight:700, color:C.green }}>{peso(t.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        ) : (
          <>
            {monthlyRows.length === 0 && (
              <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13, background:C.white, borderRadius:12, border:`1px solid ${C.border}` }}>No billing history yet.</div>
            )}
            {monthlyRows.map((r,i) => {
              const bal = r.fee - r.paid
              return (
                <div key={i} style={{ background:C.white, borderRadius:14, padding:'14px 16px', marginBottom:10, border:`1px solid ${C.border}`, borderLeft:`4px solid ${bal<=0?C.green:C.red}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                    <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{r.monthLabel}</div>
                    <div style={{ fontSize:16, fontWeight:900, color:bal<=0?C.green:C.red }}>{peso(Math.abs(bal))}{bal<=0?' ✓':' owed'}</div>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:C.muted, marginBottom:8 }}>
                    <span>Fee: {peso(r.fee)}</span>
                    <span>Paid: {peso(r.paid)}</span>
                  </div>
                  {r.txns.length > 0 && (
                    <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:8 }}>
                      {r.txns.map((t,j) => (
                        <div key={j} style={{ display:'flex', justifyContent:'space-between', fontSize:11, padding:'3px 0' }}>
                          <span style={{ color:C.muted }}>{t.method==='GCash'?'💙':'💵'} {PERIOD_LABELS[t.period]} · {fmtDate(t.date)}</span>
                          <span style={{ fontWeight:700, color:C.green }}>{peso(t.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: EXPENSES
// ═══════════════════════════════════════════════════════════
const EXPENSE_CATEGORIES = [
  { key:'Fuel (Van)',  icon:'🚐', color:'#E67E22' },
  { key:'Fuel (MC)',   icon:'🏍️', color:'#D35400' },
  { key:'Maintenance', icon:'🔧', color:'#8E44AD' },
  { key:'Others',      icon:'📦', color:C.muted     },
  { key:'Payroll',     icon:'👤', color:'#2980B9' },
]

function ScreenExpenses({ setScreen, expenses, setExpenses, showToast, attendance, cfg }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm]         = useState({ period:CURRENT_PERIOD, category:'Fuel (Van)', amount:'', description:'', date:today() })
  const [saving, setSaving]     = useState(false)
  const [view, setView]         = useState('weekly') // 'weekly' | 'monthly'
  const [period, setPeriod]     = useState(CURRENT_PERIOD)

  const totals = {}
  EXPENSE_CATEGORIES.forEach(c => { totals[c.key] = expenses.filter(e=>e.category===c.key).reduce((a,e)=>a+Number(e.amount),0) })
  const grand = Object.values(totals).reduce((a,v)=>a+v,0)

  // Weekly view: only this period's expenses
  const weeklyExpenses = expenses.filter(e => e.period === period).sort((a,b)=>new Date(b.date)-new Date(a.date))
  const weeklyTotal = weeklyExpenses.reduce((a,e)=>a+Number(e.amount),0)

  // Monthly view: rollup by month
  const periodTotals = {}
  expenses.forEach(e => { periodTotals[e.period] = (periodTotals[e.period] || 0) + Number(e.amount) })
  const monthlyData = getMonthlyTotals(periodTotals).filter(m => m.total > 0)

  // ── DRIVER DAYS AUTO-CALC ────────────────────────────────────
  // The driver's attendance is never entered separately — if he drove
  // students that week, he worked that day. So his days worked = the
  // HIGHEST days_present logged for any student that same week.
  const getDriverDays = (p) => {
    const weekRecords = attendance.filter(a => a.period === p)
    if (weekRecords.length === 0) return 0
    return Math.max(...weekRecords.map(a => a.days_present))
  }
  const driverDaysForFormPeriod = getDriverDays(form.period)
  const driverPayForFormPeriod  = driverDaysForFormPeriod * (cfg?.driverRate || 0)

  const handleSave = async () => {
    if (!form.amount || Number(form.amount) <= 0) return
    if (form.category === 'Others' && !form.description.trim()) {
      showToast('Please describe what this "Others" expense was for', 'error')
      return
    }
    setSaving(true)
    try {
      const saved = await addExpense({ ...form, amount: Number(form.amount) })
      setExpenses(prev => [saved, ...prev])
      setForm({ period:CURRENT_PERIOD, category:'Fuel (Van)', amount:'', description:'', date:today() })
      setShowForm(false)
      showToast('Expense saved!')
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={()=>setScreen('home')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>Expenses</span>
        <button onClick={()=>setShowForm(!showForm)} className="tap-bounce" style={{ background:C.amber, border:'none', borderRadius:8, padding:'6px 14px', color:C.navy, fontSize:13, fontWeight:700, cursor:'pointer' }}>
          {showForm?'Cancel':'+ Add'}
        </button>
      </div>

      {showForm && (
        <div style={{ background:C.white, borderBottom:`1px solid ${C.border}`, padding:16 }}>
          <label style={lbl}>Category</label>
          <select value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))} style={inp}>
            {EXPENSE_CATEGORIES.map(c=><option key={c.key} value={c.key}>{c.icon} {c.key}</option>)}
          </select>
          <label style={lbl}>Period (Week)</label>
          <select value={form.period} onChange={e=>setForm(p=>({...p,period:e.target.value}))} style={inp}>
            {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
          </select>

          {form.category === 'Payroll' && (
            <div style={{ background:C.gcashLt, borderRadius:10, padding:'12px 14px', marginTop:8, marginBottom:8, border:`1px solid ${C.gcash}33` }}>
              <div style={{ fontSize:12, color:C.gcash, fontWeight:700, marginBottom:4 }}>🚐 Driver's Days (auto)</div>
              <div style={{ fontSize:12, color:C.navyMd }}>
                Highest attendance logged this week = <b>{driverDaysForFormPeriod} day{driverDaysForFormPeriod!==1?'s':''}</b> driven
                {cfg?.driverRate ? <> × {peso(cfg.driverRate)}/day = <b>{peso(driverPayForFormPeriod)}</b></> : null}
              </div>
              {driverDaysForFormPeriod > 0 && cfg?.driverRate > 0 && (
                <button onClick={()=>setForm(p=>({...p, amount:String(driverPayForFormPeriod), description: p.description || `${driverDaysForFormPeriod} days driven`}))} className="tap-shrink"
                  style={{ marginTop:8, padding:'6px 14px', background:C.gcash, color:C.white, border:'none', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                  Use this amount
                </button>
              )}
            </div>
          )}

          <label style={lbl}>Amount (₱)</label>
          <input type="number" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="0" style={inp}/>
          <label style={lbl}>
            {form.category === 'Others' ? 'What was this for? (required)' : 'Description (optional)'}
          </label>
          <input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))}
            placeholder={form.category === 'Others' ? 'e.g. Umbrella replacement, toll fee…' : 'e.g. Fuel refill – Petron'}
            style={{ ...inp, border:form.category==='Others' && !form.description ? `2px solid ${C.amber}` : inp.border }}/>
          {form.category === 'Others' && (
            <div style={{ fontSize:11, color:C.amber, marginTop:-8, marginBottom:12 }}>
              ℹ️ Please describe "Others" expenses clearly for proper monitoring.
            </div>
          )}
          <button onClick={handleSave} disabled={saving} className="tap-bounce"
            style={{ width:'100%', padding:'13px', background:saving?C.muted:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.white, border:'none', borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer', marginTop:12 }}>
            {saving?'Saving…':'Save Expense'}
          </button>
        </div>
      )}

      <div style={{ padding:'16px' }}>
        {/* CATEGORY TOTALS (all time) */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
          {EXPENSE_CATEGORIES.map(c=>(
            <div key={c.key} style={{ background:C.white, borderRadius:12, padding:'12px 14px', border:`1px solid ${C.border}`, borderTop:`3px solid ${c.color}` }}>
              <div style={{ fontSize:18 }}>{c.icon}</div>
              <div style={{ fontSize:15, fontWeight:800, color:c.color, marginTop:4 }}>{peso(totals[c.key])}</div>
              <div style={{ fontSize:11, color:C.muted }}>{c.key}</div>
            </div>
          ))}
        </div>
        <div style={{ background:C.navy, borderRadius:12, padding:'12px 16px', color:C.white, display:'flex', justifyContent:'space-between', marginBottom:16 }}>
          <span style={{ fontSize:14, fontWeight:600 }}>Total Expenses (All Time)</span>
          <span style={{ fontSize:18, fontWeight:900, color:C.amberLt }}>{peso(grand)}</span>
        </div>

        {/* EXPORT PDF */}
        <button onClick={()=>setScreen('exportPdf')} className="tap-bounce"
          style={{ width:'100%', padding:'12px', background:`linear-gradient(135deg,#3D5A99,${C.navy})`, color:C.white, border:'none', borderRadius:12, fontSize:13, fontWeight:800, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8, marginBottom:16, boxShadow:`0 4px 12px ${C.navy}44` }}>
          🖨️ Export Expense PDF Report
        </button>

        {/* WEEKLY / MONTHLY TOGGLE */}
        <div style={{ display:'flex', gap:8, marginBottom:14 }}>
          {[{k:'weekly',l:'📅 Weekly'},{k:'monthly',l:'🗂 Monthly'}].map(o => (
            <button key={o.k} onClick={()=>setView(o.k)} className="tap-bounce"
              style={{ flex:1, padding:'10px', borderRadius:12, cursor:'pointer', fontSize:13, fontWeight:800,
                background: view===o.k ? `linear-gradient(135deg,${C.amber},${C.amberLt})` : C.white,
                color: view===o.k ? C.navy : C.muted,
                boxShadow: view===o.k ? `0 4px 14px ${C.amber}44` : `0 1px 3px rgba(0,0,0,.06)`,
                border: view===o.k ? 'none' : `1px solid ${C.border}` }}>
              {o.l}
            </button>
          ))}
        </div>

        {view === 'weekly' ? (
          <>
            <WeekNavigator period={period} setPeriod={setPeriod} label="Select Week"/>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:C.muted, marginBottom:10 }}>
              <span>Total this week</span>
              <span style={{ fontWeight:800, color:C.text }}>{peso(weeklyTotal)}</span>
            </div>
            {weeklyExpenses.length===0 && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13, background:C.white, borderRadius:12, border:`1px solid ${C.border}` }}>No expenses logged for this week.</div>}
            {weeklyExpenses.map((e,i) => {
              const cat = EXPENSE_CATEGORIES.find(c=>c.key===e.category)
              return (
                <div key={i} style={{ background:C.white, borderRadius:10, padding:'11px 14px', marginBottom:8, border:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                    <span style={{ fontSize:18 }}>{cat?.icon}</span>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{e.category}{e.description?` — ${e.description}`:''}</div>
                      <div style={{ fontSize:11, color:C.muted }}>{fmtDate(e.date)}</div>
                    </div>
                  </div>
                  <div style={{ fontSize:14, fontWeight:800, color:C.red }}>{peso(e.amount)}</div>
                </div>
              )
            })}
          </>
        ) : (
          <>
            {monthlyData.length === 0 && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13, background:C.white, borderRadius:12, border:`1px solid ${C.border}` }}>No monthly data yet.</div>}
            {monthlyData.map((m,i) => (
              <div key={i} style={{ background:C.white, borderRadius:14, padding:'14px 16px', marginBottom:8, border:`1px solid ${C.border}`, borderLeft:`4px solid ${C.amber}` }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div>
                    <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{m.monthLabel}</div>
                    <div style={{ fontSize:11, color:C.muted }}>{m.weeks.length} week{m.weeks.length!==1?'s':''}</div>
                  </div>
                  <div style={{ fontSize:18, fontWeight:900, color:C.red }}>{peso(m.total)}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: SETTINGS
// ═══════════════════════════════════════════════════════════
function ScreenSettings({ setScreen, settings, onSave, onSignOut }) {
  const [local, setLocal] = useState({ ...settings })
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    await onSave(local)
    setSaving(false)
    setScreen('home')
  }

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={()=>setScreen('home')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white }}>Settings</span>
      </div>
      <div style={{ padding:'16px' }}>
        <div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden', marginBottom:16 }}>
          <div style={{ padding:'12px 16px', background:C.cream, fontSize:12, fontWeight:700, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>Rates</div>
          {[
            { label:'Daily Student Rate (₱)', key:'daily_rate',  min:100, max:1000, step:10  },
            { label:'Driver Daily Rate (₱)',  key:'driver_rate', min:300, max:800,  step:50  },
          ].map(f=>(
            <div key={f.key} style={{ padding:'14px 16px', borderBottom:`1px solid ${C.border}` }}>
              <label style={{ fontSize:13, fontWeight:600, color:C.text }}>{f.label}</label>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:8 }}>
                <input type="range" min={f.min} max={f.max} step={f.step} value={local[f.key]||0}
                  onChange={e=>setLocal(p=>({...p,[f.key]:e.target.value}))} style={{ flex:1, accentColor:C.gcash }}/>
                <input type="number" value={local[f.key]||''} onChange={e=>setLocal(p=>({...p,[f.key]:e.target.value}))}
                  style={{ width:72, padding:'5px 8px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:14, fontWeight:700, color:C.gcash, textAlign:'center' }}/>
              </div>
            </div>
          ))}
          <div style={{ padding:'14px 16px', background:C.gcashLt }}>
            <div style={{ fontSize:12, color:C.gcash, fontWeight:600 }}>
              Full week (5 days, Mon–Fri) = {peso((local.daily_rate||0) * 5)} per student
            </div>
            <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
              Actual fees are based on each student's real attendance — set this in Settings → Attendance & Fees.
            </div>
          </div>
        </div>

        <div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden', marginBottom:16 }}>
          <div style={{ padding:'12px 16px', background:C.cream, fontSize:12, fontWeight:700, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>Student Records</div>
          <div style={{ padding:'14px 16px' }}>
            <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Add new students, edit names and contact details, or remove students who've left.</div>
            <button onClick={()=>setScreen('manage')} className="tap-bounce"
              style={{ width:'100%', padding:'14px', background:`linear-gradient(135deg,#3D5A99,${C.navy})`, color:C.white, border:'none', borderRadius:12, fontSize:14, fontWeight:800, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:10, marginBottom:10, boxShadow:`0 4px 12px ${C.navy}44` }}>
              <span style={{ fontSize:20 }}>👥</span> Manage Students
            </button>
            <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Enter each student's days present this period — fees are calculated individually.</div>
            <button onClick={()=>setScreen('attendance')} className="tap-bounce"
              style={{ width:'100%', padding:'14px', background:`linear-gradient(135deg,${C.amberLt},${C.amber})`, color:C.navy, border:'none', borderRadius:12, fontSize:14, fontWeight:800, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:10, marginBottom:10, boxShadow:`0 4px 12px ${C.amber}55` }}>
              <span style={{ fontSize:20 }}>🗓</span> Attendance & Fees
            </button>
            <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Send each guardian a text reminder of this week's fee and running balance.</div>
            <button onClick={()=>setScreen('smsReminders')} className="tap-bounce"
              style={{ width:'100%', padding:'14px', background:`linear-gradient(135deg,#5FE39A,${C.green})`, color:C.white, border:'none', borderRadius:12, fontSize:14, fontWeight:800, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:10, boxShadow:`0 4px 12px ${C.green}55` }}>
              <span style={{ fontSize:20 }}>💬</span> SMS Reminders
            </button>
          </div>
        </div>

        <div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden', marginBottom:16 }}>
          <div style={{ padding:'12px 16px', background:C.cream, fontSize:12, fontWeight:700, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>GCash Account</div>
          <div style={{ padding:'14px 16px' }}>
            <label style={lbl}>GCash Number</label>
            <input value={local.gcash_number||''} onChange={e=>setLocal(p=>({...p,gcash_number:e.target.value}))} style={{ ...inp, fontFamily:'monospace', fontWeight:700 }}/>
            <label style={lbl}>Account Name</label>
            <input value={local.gcash_name||''} onChange={e=>setLocal(p=>({...p,gcash_name:e.target.value}))} style={inp}/>
          </div>
        </div>

        <button onClick={handleSave} disabled={saving} className="tap-bounce"
          style={{ width:'100%', padding:'15px', background:saving?C.muted:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:'pointer', marginBottom:12 }}>
          {saving?'Saving…':'💾 Save Settings'}
        </button>
        <button onClick={onSignOut} className="tap-bounce"
          style={{ width:'100%', padding:'13px', background:C.white, color:C.red, border:`1px solid ${C.red}44`, borderRadius:14, fontSize:14, fontWeight:700, cursor:'pointer' }}>
          Sign Out
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: MANAGE STUDENTS (Add / Edit / Remove)
// ═══════════════════════════════════════════════════════════
function ScreenManageStudents({ setScreen, students, setStudents, showToast }) {
  const [mode, setMode]       = useState('list')   // 'list' | 'add' | 'edit'
  const [editing, setEditing] = useState(null)      // student being edited
  const [showInactive, setShowInactive] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null) // student pending hard-delete confirmation
  const [saving, setSaving]   = useState(false)

  const blank = { name:'', nickname:'', grade:7, guardian:'', contact:'', address:'', parent_email:'' }
  const [form, setForm] = useState(blank)

  const startAdd = () => { setForm(blank); setMode('add') }
  const startEdit = (s) => { setForm({ name:s.name, nickname:s.nickname||'', grade:s.grade, guardian:s.guardian||'', contact:s.contact||'', address:s.address||'', parent_email:s.parent_email||'' }); setEditing(s); setMode('edit') }
  const cancel = () => { setMode('list'); setEditing(null); setForm(blank) }

  const handleSaveNew = async () => {
    if (!form.name.trim()) { showToast('Student name is required', 'error'); return }
    setSaving(true)
    try {
      const created = await addStudent({ ...form, grade:Number(form.grade), active:true })
      setStudents(prev => [...prev, created].sort((a,b)=>a.name.localeCompare(b.name)))
      showToast(`${created.name} added!`)
      cancel()
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!form.name.trim()) { showToast('Student name is required', 'error'); return }
    setSaving(true)
    try {
      await updateStudent(editing.id, { ...form, grade:Number(form.grade) })
      setStudents(prev => prev.map(s => s.id===editing.id ? { ...s, ...form, grade:Number(form.grade) } : s).sort((a,b)=>a.name.localeCompare(b.name)))
      showToast('Student updated!')
      cancel()
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDeactivate = async (s) => {
    try {
      await deactivateStudent(s.id)
      setStudents(prev => prev.map(x => x.id===s.id ? { ...x, active:false } : x))
      showToast(`${s.name} removed from active list`)
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const handleReactivate = async (s) => {
    try {
      await reactivateStudent(s.id)
      setStudents(prev => prev.map(x => x.id===s.id ? { ...x, active:true } : x))
      showToast(`${s.name} restored`)
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const handlePermanentDelete = async (s) => {
    try {
      await permanentlyDeleteStudent(s.id)
      setStudents(prev => prev.filter(x => x.id !== s.id))
      showToast(`${s.name} permanently deleted`)
      setConfirmDelete(null)
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const visibleStudents = students.filter(s => showInactive ? true : s.active !== false).sort((a,b) => a.name.localeCompare(b.name))
  const filingNumbers = getFilingNumbers(students)

  const Header = ({ title, back }) => (
    <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, position:'sticky', top:0, zIndex:10 }}>
      <button onClick={back} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
      <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>{title}</span>
    </div>
  )

  // ── FORM (shared for Add and Edit) ──────────────────────────
  if (mode === 'add' || mode === 'edit') return (
    <div style={{ paddingBottom:40 }}>
      <Header title={mode==='add' ? 'Add Student' : 'Edit Student'} back={cancel}/>
      <div style={{ padding:16 }}>
        <label style={lbl}>Full Name</label>
        <input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Dela Cruz, Juan" style={inp}/>

        <label style={lbl}>Nickname (optional)</label>
        <input value={form.nickname} onChange={e=>setForm(p=>({...p,nickname:e.target.value}))} placeholder="e.g. Jun-jun" style={inp}/>

        <label style={lbl}>Grade Level</label>
        <select value={form.grade} onChange={e=>setForm(p=>({...p,grade:e.target.value}))} style={inp}>
          {[7,8,9,10,11,12].map(g => <option key={g} value={g}>Grade {g}</option>)}
        </select>

        <label style={lbl}>Guardian / Contact Person</label>
        <input value={form.guardian} onChange={e=>setForm(p=>({...p,guardian:e.target.value}))} placeholder="e.g. Maria Dela Cruz" style={inp}/>

        <label style={lbl}>Contact Number</label>
        <input value={form.contact} onChange={e=>setForm(p=>({...p,contact:e.target.value}))} placeholder="e.g. 0917-123-4567" style={inp}/>

        <label style={lbl}>Address</label>
        <input value={form.address} onChange={e=>setForm(p=>({...p,address:e.target.value}))} placeholder="e.g. Purok 2, Roxas, Or. Mindoro" style={inp}/>

        <label style={lbl}>Parent's Login Email (optional)</label>
        <input value={form.parent_email} onChange={e=>setForm(p=>({...p,parent_email:e.target.value}))} placeholder="e.g. parent@gmail.com" style={inp}/>
        <div style={{ fontSize:11, color:C.muted, marginTop:-8, marginBottom:12 }}>
          Create this exact email as a login in Supabase, set their role to "parent", and they'll see only this student.
        </div>

        <button onClick={mode==='add' ? handleSaveNew : handleSaveEdit} disabled={saving} className="tap-bounce"
          style={{ width:'100%', padding:14, background:saving?C.muted:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, border:'none', borderRadius:12, fontSize:15, fontWeight:800, cursor:'pointer', marginTop:4 }}>
          {saving ? 'Saving…' : mode==='add' ? '+ Add Student' : '💾 Save Changes'}
        </button>

        {mode === 'edit' && (
          <button onClick={()=>{ handleDeactivate(editing); cancel() }} className="tap-bounce"
            style={{ width:'100%', padding:13, background:C.white, color:C.red, border:`1px solid ${C.red}44`, borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer', marginTop:10 }}>
            🗑 Remove from Active List
          </button>
        )}
      </div>
    </div>
  )

  // ── LIST VIEW ─────────────────────────────────────────────────
  return (
    <div style={{ paddingBottom:90 }}>
      <Header title={`Manage Students (${students.filter(s=>s.active!==false).length})`} back={()=>setScreen('settings')}/>

      <div style={{ padding:'12px 16px 0' }}>
        <button onClick={startAdd} className="tap-bounce"
          style={{ width:'100%', padding:13, background:`linear-gradient(135deg,${C.green},#157f3b)`, color:C.white, border:'none', borderRadius:12, fontSize:14, fontWeight:800, cursor:'pointer', marginBottom:12, boxShadow:`0 4px 12px ${C.green}44` }}>
          ➕ Add New Student
        </button>

        <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:C.muted, marginBottom:10, cursor:'pointer' }}>
          <input type="checkbox" checked={showInactive} onChange={e=>setShowInactive(e.target.checked)}/>
          Show removed students too
        </label>
      </div>

      <div style={{ padding:'0 16px' }}>
        {visibleStudents.map(s => (
          <div key={s.id} style={{ background:C.white, borderRadius:12, padding:'12px 14px', marginBottom:8, border:`1px solid ${C.border}`, opacity:s.active===false?0.55:1 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
              <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                {s.active !== false && (
                  <div style={{ width:26, height:26, borderRadius:8, background:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.amberLt, fontSize:12, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1 }}>
                    {filingNumbers[s.id]}
                  </div>
                )}
                <div>
                  <div style={{ fontSize:14, fontWeight:700, color:C.text }}>
                    {s.name}{s.nickname && <span style={{ color:C.muted, fontWeight:500 }}> "{s.nickname}"</span>} {s.active===false && <span style={{ fontSize:10, color:C.red, fontWeight:700 }}>(REMOVED)</span>}
                  </div>
                  <div style={{ fontSize:11, color:C.muted }}>Grade {s.grade} · {s.guardian} · {s.contact}</div>
                  {s.address && <div style={{ fontSize:11, color:C.muted }}>📍 {s.address}</div>}
                  {s.parent_email && <div style={{ fontSize:11, color:C.gcash }}>👤 Parent login: {s.parent_email}</div>}
                </div>
              </div>
              <span style={{ background:C.navy, color:C.amberLt, fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:10, flexShrink:0 }}>GR.{s.grade}</span>
            </div>

            <div style={{ display:'flex', gap:8 }}>
              {s.active !== false ? (
                <>
                  <button onClick={()=>startEdit(s)}
                    style={{ flex:1, padding:'8px', background:C.gcashLt, color:C.gcash, border:'none', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                    ✏️ Edit
                  </button>
                  <button onClick={()=>handleDeactivate(s)}
                    style={{ flex:1, padding:'8px', background:C.redLt, color:C.red, border:'none', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                    🗑 Remove
                  </button>
                </>
              ) : (
                <>
                  <button onClick={()=>handleReactivate(s)}
                    style={{ flex:1, padding:'8px', background:C.greenLt, color:C.green, border:'none', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                    ↩️ Restore
                  </button>
                  <button onClick={()=>setConfirmDelete(s)}
                    style={{ flex:1, padding:'8px', background:C.redLt, color:C.red, border:'none', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                    ⚠️ Delete Forever
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {visibleStudents.length === 0 && (
          <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14 }}>No students to show.</div>
        )}
      </div>

      {/* CONFIRM PERMANENT DELETE MODAL */}
      {confirmDelete && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:999, padding:24 }}>
          <div style={{ background:C.white, borderRadius:16, padding:24, maxWidth:340, width:'100%' }}>
            <div style={{ fontSize:32, textAlign:'center', marginBottom:8 }}>⚠️</div>
            <div style={{ fontSize:16, fontWeight:800, color:C.text, textAlign:'center', marginBottom:8 }}>Delete {confirmDelete.name} permanently?</div>
            <div style={{ fontSize:13, color:C.muted, textAlign:'center', marginBottom:20 }}>This also deletes their entire payment history. This cannot be undone. Consider "Remove" instead if you just want to hide them.</div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={()=>setConfirmDelete(null)} style={{ flex:1, padding:12, background:C.cream, color:C.text, border:'none', borderRadius:10, fontSize:14, fontWeight:700, cursor:'pointer' }}>Cancel</button>
              <button onClick={()=>handlePermanentDelete(confirmDelete)} style={{ flex:1, padding:12, background:C.red, color:C.white, border:'none', borderRadius:10, fontSize:14, fontWeight:700, cursor:'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: SMS REMINDERS — bulk list, tap each to send one at a time
// ═══════════════════════════════════════════════════════════
function ScreenSmsReminders({ setScreen, students, txns, attendance, cfg }) {
  const [period, setPeriod] = useState(CURRENT_PERIOD)
  const [sentIds, setSentIds] = useState(new Set())
  const activeStudents = students.filter(s => s.active !== false).sort((a,b) => a.name.localeCompare(b.name))
  const filingNumbers = getFilingNumbers(students)

  const handleSend = (student) => {
    const rb = getRunningBalance(student.id, attendance, txns, cfg.rate, period)
    const message = buildSmsMessage(student, rb, cfg, period)
    const phone = (student.contact || '').replace(/[^0-9+]/g, '')
    if (!phone) {
      alert('No contact number on file for this student/guardian.')
      return
    }
    // sms: link opens the phone's own Messages app with the text pre-filled.
    // The person still taps Send themselves — nothing is sent automatically.
    window.location.href = `sms:${phone}?body=${encodeURIComponent(message)}`
    setSentIds(prev => new Set(prev).add(student.id))
  }

  return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, position:'sticky', top:0, zIndex:10 }}>
        <button onClick={()=>setScreen('settings')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>SMS Reminders</span>
      </div>

      <div style={{ padding:'14px 16px' }}>
        <WeekNavigator period={period} setPeriod={setPeriod} label="Week to Report"/>
        <div style={{ fontSize:11, color:C.muted, marginBottom:14 }}>
          Tap a student to open Messages with their reminder pre-filled — you tap Send yourself.
        </div>

        <div style={{ background:C.yellow, borderRadius:10, padding:'10px 14px', fontSize:12, color:C.yellowDk, marginBottom:16 }}>
          ℹ️ This opens your phone's Messages app — it does not send automatically yet. A future upgrade can fully automate this with an SMS gateway.
        </div>

        {activeStudents.map(s => {
          const rb = getRunningBalance(s.id, attendance, txns, cfg.rate, period)
          const sent = sentIds.has(s.id)
          return (
            <div key={s.id} style={{ background:C.white, borderRadius:12, padding:'12px 14px', marginBottom:8, border:`1px solid ${C.border}`, opacity:sent?0.7:1 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                  <div style={{ width:26, height:26, borderRadius:8, background:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.amberLt, fontSize:12, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    {filingNumbers[s.id]}
                  </div>
                  <div>
                    <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.name}{s.nickname && <span style={{ color:C.muted, fontWeight:500 }}> "{s.nickname}"</span>}</div>
                    <div style={{ fontSize:11, color:C.muted }}>{s.guardian} · {s.contact || 'No number on file'}</div>
                  </div>
                </div>
                {sent && <span style={{ fontSize:11, color:C.green, fontWeight:700 }}>✅ Sent</span>}
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:C.muted, marginBottom:10 }}>
                <span>Due: <b style={{ color:C.text }}>{peso(rb.amountDue)}</b></span>
                <span>Balance: <b style={{ color:rb.balance>0?C.red:rb.balance<0?C.amber:C.green }}>{peso(rb.balance)}</b></span>
              </div>
              <button onClick={()=>handleSend(s)} disabled={!s.contact} className="tap-bounce"
                style={{ width:'100%', padding:10, background:!s.contact?'#ccc':`linear-gradient(135deg,#5FE39A,${C.green})`, color:C.white, border:'none', borderRadius:10, fontSize:13, fontWeight:800, cursor:!s.contact?'not-allowed':'pointer' }}>
                💬 {sent ? 'Send Again' : 'Send SMS Reminder'}
              </button>
            </div>
          )
        })}
        {activeStudents.length === 0 && (
          <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14 }}>No active students yet.</div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: ATTENDANCE & FEES (per-student days present → fee)
// ═══════════════════════════════════════════════════════════
function ScreenAttendance({ setScreen, students, attendance, cfg, onSetAttendance }) {
  const [period, setPeriod] = useState(CURRENT_PERIOD)
  const activeStudents = students.filter(s => s.active !== false).sort((a,b) => a.name.localeCompare(b.name))
  const filingNumbers = getFilingNumbers(students)

  const getDays = (studentId) => {
    const rec = attendance.find(a => a.student_id === studentId && a.period === period)
    return rec ? rec.days_present : 0
  }

  const adjust = (studentId, delta) => {
    const next = Math.max(0, Math.min(5, getDays(studentId) + delta))
    onSetAttendance(studentId, period, next)
  }

  const setDirect = (studentId, value) => {
    const num = Math.max(0, Math.min(5, Number(value) || 0))
    onSetAttendance(studentId, period, num)
  }

  const totalFees = activeStudents.reduce((a, s) => a + getDays(s.id) * cfg.rate, 0)
  const totalDays = activeStudents.reduce((a, s) => a + getDays(s.id), 0)

  return (
    <div style={{ paddingBottom:40 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, position:'sticky', top:0, zIndex:10 }}>
        <button onClick={()=>setScreen('settings')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>Attendance & Fees</span>
      </div>

      <div style={{ padding:'14px 16px' }}>
        <WeekNavigator period={period} setPeriod={setPeriod} label="Week"/>
        <div style={{ fontSize:12, color:C.muted, marginTop:4, marginBottom:8 }}>Mon–Fri school week</div>

        <div style={{ display:'flex', gap:10, margin:'14px 0' }}>
          <div style={{ flex:1, background:C.white, borderRadius:12, padding:'12px 14px', border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:11, color:C.muted }}>Daily Rate</div>
            <div style={{ fontSize:18, fontWeight:800, color:C.gcash }}>{peso(cfg.rate)}</div>
          </div>
          <div style={{ flex:1, background:C.white, borderRadius:12, padding:'12px 14px', border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:11, color:C.muted }}>Total Days Logged</div>
            <div style={{ fontSize:18, fontWeight:800, color:C.navy }}>{totalDays}</div>
          </div>
        </div>

        <div style={{ background:C.navy, borderRadius:12, padding:'14px 16px', display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <span style={{ color:C.white, fontSize:13, fontWeight:600 }}>Total Fees This Week</span>
          <span style={{ color:C.amberLt, fontSize:20, fontWeight:900 }}>{peso(totalFees)}</span>
        </div>

        <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>
          Tap − or + to adjust, or type the day count directly. Fee = days present × {peso(cfg.rate)}/day. Max 5 days (Mon–Fri) for {PERIOD_LABELS[period]}.
        </div>

        {activeStudents.map(s => {
          const days = getDays(s.id)
          const fee  = days * cfg.rate
          return (
            <div key={s.id} style={{ background:C.white, borderRadius:12, padding:'12px 14px', marginBottom:8, border:`1px solid ${C.border}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                  <div style={{ width:26, height:26, borderRadius:8, background:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.amberLt, fontSize:12, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1 }}>
                    {filingNumbers[s.id]}
                  </div>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{s.name}{s.nickname && <span style={{ color:C.muted, fontWeight:500 }}> "{s.nickname}"</span>}</div>
                    <div style={{ fontSize:11, color:C.muted }}>Grade {s.grade}</div>
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:15, fontWeight:800, color:C.green }}>{peso(fee)}</div>
                  <div style={{ fontSize:10, color:C.muted }}>fee this period</div>
                </div>
              </div>

              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <button onClick={()=>adjust(s.id, -1)} className="tap-bounce"
                  style={{ width:42, height:42, borderRadius:13, background:`linear-gradient(135deg,#FF8A80,${C.red})`, color:C.white, border:'none', fontSize:22, fontWeight:900, cursor:'pointer', flexShrink:0, boxShadow:`0 3px 10px ${C.red}55` }}>
                  −
                </button>
                <input type="number" value={days} min={0} max={5}
                  onChange={e=>setDirect(s.id, e.target.value)}
                  style={{ flex:1, textAlign:'center', padding:'10px 4px', borderRadius:11, border:`2px solid ${C.border}`, fontSize:18, fontWeight:800, color:C.navy }}/>
                <button onClick={()=>adjust(s.id, 1)} className="tap-bounce"
                  style={{ width:42, height:42, borderRadius:13, background:`linear-gradient(135deg,#5FE39A,${C.green})`, color:C.white, border:'none', fontSize:22, fontWeight:900, cursor:'pointer', flexShrink:0, boxShadow:`0 3px 10px ${C.green}55` }}>
                  +
                </button>
                <span style={{ fontSize:11, color:C.muted, width:40, flexShrink:0 }}>/ 5 days</span>
              </div>
            </div>
          )
        })}
        {activeStudents.length === 0 && (
          <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14 }}>No active students yet.</div>
        )}
      </div>
    </div>
  )
}
