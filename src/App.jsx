// ============================================================
// src/App.jsx  —  NEB 1887 School Bus Management App
// Full Supabase-wired version
// ============================================================

import { useState, useEffect, useRef } from 'react'
import {
  supabase,
  signIn, signOut, onAuthChange,
  loadSettings, saveSettings,
  loadStudents,
  loadTransactions, addTransaction,
  loadExpenses, addExpense,
  loadMonthlySummary,
  subscribeToTransactions,
} from './supabaseClient'

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
const today   = () => new Date().toISOString().slice(0,10)

const PERIODS = ['Jun 2025','Jul 2025','Aug 2025','Sep 2025','Oct 2025',
                 'Nov 2025','Dec 2025','Jan 2026','Feb 2026','Mar 2026',
                 'Apr 2026','May 2026','Jun 2026']
const CURRENT_PERIOD = 'Apr 2026'

// ─── SHARED STYLE HELPERS ────────────────────────────────────
const lbl = { display:'block', fontSize:12, fontWeight:600, color:C.muted, marginBottom:5, marginTop:12, letterSpacing:.5, textTransform:'uppercase' }
const inp = { display:'block', width:'100%', padding:'11px 14px', borderRadius:10, border:`1px solid ${C.border}`, fontSize:14, color:C.text, background:C.white, boxSizing:'border-box', outline:'none' }

// ═══════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [user,     setUser]     = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [screen,   setScreen]   = useState('home')
  const [students, setStudents] = useState([])
  const [txns,     setTxns]     = useState([])
  const [expenses, setExpenses] = useState([])
  const [settings, setSettings] = useState({ daily_rate:'240', school_days:'22', driver_rate:'500', gcash_number:'09XX-XXX-XXXX', gcash_name:'Lucky Shining Star Dev. Corp.', bus_unit:'NEB 1887' })
  const [toast,    setToast]    = useState(null)
  const [payState, setPayState] = useState(null)

  // ── AUTH ───────────────────────────────────────────────────
  useEffect(() => {
    const { data: { subscription } } = onAuthChange(u => {
      setUser(u)
      setLoading(false)
    })
    return () => subscription.unsubscribe()
  }, [])

  // ── LOAD DATA WHEN LOGGED IN ───────────────────────────────
  useEffect(() => {
    if (!user) return
    Promise.all([
      loadStudents().then(setStudents),
      loadTransactions().then(setTxns),
      loadExpenses().then(setExpenses),
      loadSettings().then(setSettings),
    ]).catch(err => showToast(err.message, 'error'))
  }, [user])

  // ── REALTIME SUBSCRIPTION ──────────────────────────────────
  useEffect(() => {
    if (!user) return
    const unsub = subscribeToTransactions(newTxn => {
      setTxns(prev => [newTxn, ...prev])
      showToast('New payment recorded on another device!', 'info')
    })
    return unsub
  }, [user])

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

  const cfg = {
    rate:       Number(settings.daily_rate  || 240),
    days:       Number(settings.school_days || 22),
    driverRate: Number(settings.driver_rate || 500),
    gcashNum:   settings.gcash_number || '09XX-XXX-XXXX',
    gcashName:  settings.gcash_name   || 'Lucky Shining Star Dev. Corp.',
    busUnit:    settings.bus_unit     || 'NEB 1887',
  }

  if (loading) return <Splash/>
  if (!user)   return <LoginScreen onLogin={(u) => setUser(u)} showToast={showToast}/>

  return (
    <div style={{ fontFamily:"'Segoe UI',system-ui,sans-serif", background:C.cream, minHeight:'100vh', maxWidth:430, margin:'0 auto', position:'relative' }}>
      <div style={{ background: screen==='home' ? C.gcash : C.navy, height:8 }}/>

      {screen==='home'     && <ScreenHome     setScreen={setScreen} txns={txns} cfg={cfg} students={students}/>}
      {screen==='pay'      && <ScreenPay      setScreen={setScreen} onSave={handleAddTransaction} cfg={cfg} students={students} payState={payState} setPayState={setPayState}/>}
      {screen==='history'  && <ScreenHistory  setScreen={setScreen} txns={txns} students={students}/>}
      {screen==='students' && <ScreenStudents setScreen={setScreen} txns={txns} cfg={cfg} students={students} setPayState={setPayState}/>}
      {screen==='expenses' && <ScreenExpenses setScreen={setScreen} expenses={expenses} setExpenses={setExpenses} showToast={showToast}/>}
      {screen==='settings' && <ScreenSettings setScreen={setScreen} settings={settings} onSave={handleSaveSettings} onSignOut={async()=>{ await signOut(); setUser(null) }}/>}
      {screen==='receipt'  && <ScreenReceipt  setScreen={setScreen} payState={payState} cfg={cfg}/>}

      {screen !== 'receipt' && (
        <nav style={{ position:'fixed', bottom:0, left:'50%', transform:'translateX(-50%)', width:'100%', maxWidth:430, background:C.white, borderTop:`1px solid ${C.border}`, display:'flex', zIndex:200, boxShadow:'0 -2px 12px rgba(0,0,0,.08)' }}>
          {[
            { key:'home',     icon:'🏠', label:'Home'     },
            { key:'students', icon:'👥', label:'Students' },
            { key:'pay',      icon:'💳', label:'Pay',     accent:true },
            { key:'history',  icon:'📋', label:'History'  },
            { key:'expenses', icon:'📊', label:'Expenses' },
          ].map(n => (
            <button key={n.key} onClick={()=>{ if(n.key==='pay') setPayState(null); setScreen(n.key) }}
              style={{ flex:1, border:'none', background:'transparent', cursor:'pointer', padding:'8px 4px 10px', display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              {n.accent
                ? <div style={{ width:44, height:44, background:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, borderRadius:14, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, marginTop:-18, boxShadow:`0 4px 14px ${C.gcash}55` }}>{n.icon}</div>
                : <span style={{ fontSize:20 }}>{n.icon}</span>}
              <span style={{ fontSize:10, fontWeight:screen===n.key?700:400, color:screen===n.key?C.gcash:C.muted }}>{n.label}</span>
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

// ─── SPLASH ──────────────────────────────────────────────────
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
function ScreenHome({ setScreen, txns, cfg, students }) {
  const monthlyFee     = cfg.rate * cfg.days
  const periodTxns     = txns.filter(t => t.period === CURRENT_PERIOD && t.status === 'confirmed')
  const totalCollected = periodTxns.reduce((a,t) => a + Number(t.amount), 0)
  const totalExpected  = students.length * monthlyFee
  const paidStudents   = new Set(periodTxns.map(t => t.student_id)).size
  const gcashAmt       = txns.filter(t=>t.method==='GCash').reduce((a,t)=>a+Number(t.amount),0)
  const cashAmt        = txns.filter(t=>t.method==='Cash').reduce((a,t)=>a+Number(t.amount),0)
  const recentTxns     = txns.slice(0, 5)

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:`linear-gradient(160deg,${C.gcash} 0%,${C.gcashDk} 100%)`, padding:'24px 20px 32px', color:C.white }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:11, opacity:.8, letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>{cfg.busUnit}</div>
            <div style={{ fontSize:22, fontWeight:900 }}>School Bus Payments</div>
            <div style={{ fontSize:12, opacity:.75, marginTop:2 }}>{cfg.gcashName}</div>
          </div>
          <button onClick={()=>setScreen('settings')} style={{ background:'rgba(255,255,255,.2)', border:'none', borderRadius:10, padding:'8px 14px', color:C.white, fontSize:12, fontWeight:600, cursor:'pointer' }}>⚙</button>
        </div>
        <div style={{ background:'rgba(255,255,255,.15)', borderRadius:16, padding:'16px 20px', marginTop:20 }}>
          <div style={{ fontSize:11, opacity:.8, letterSpacing:1, textTransform:'uppercase' }}>{CURRENT_PERIOD} Collection</div>
          <div style={{ fontSize:34, fontWeight:900, marginTop:4 }}>{peso(totalCollected)}</div>
          <div style={{ fontSize:12, opacity:.8, marginTop:2 }}>of {peso(totalExpected)} expected · {paidStudents}/{students.length} students paid</div>
          <div style={{ background:'rgba(255,255,255,.25)', borderRadius:4, height:6, marginTop:12, overflow:'hidden' }}>
            <div style={{ background:C.amberLt, height:'100%', width:`${Math.min(100, totalExpected > 0 ? totalCollected/totalExpected*100 : 0).toFixed(0)}%`, borderRadius:4, transition:'width .6s' }}/>
          </div>
          <div style={{ fontSize:11, opacity:.8, marginTop:4 }}>{totalExpected > 0 ? (totalCollected/totalExpected*100).toFixed(1) : 0}% collected</div>
        </div>
      </div>

      <div style={{ padding:'16px 16px 0' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
          {[
            { label:'Record Payment', sub:'GCash or Cash',    icon:'💳', color:C.gcash,   screen:'pay'      },
            { label:'View Students',  sub:'Balances & info',  icon:'👥', color:C.navyMd,  screen:'students' },
            { label:'Transactions',   sub:'Full history',     icon:'📋', color:C.green,   screen:'history'  },
            { label:'Expenses',       sub:'Fuel, salary…',   icon:'📊', color:C.amber,   screen:'expenses' },
          ].map(a => (
            <button key={a.label} onClick={()=>setScreen(a.screen)}
              style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:14, padding:'14px 12px', cursor:'pointer', textAlign:'left', display:'flex', gap:10, alignItems:'center' }}>
              <div style={{ width:40, height:40, background:a.color+'18', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>{a.icon}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{a.label}</div>
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
                    <div style={{ fontSize:11, color:C.muted }}>{t.method} · {t.period} · {t.ref}</div>
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
  if (step === 1) return (
    <div style={{ paddingBottom:80 }}>
      <Header title="Select Student" back={()=>setScreen('home')}/>
      <div style={{ padding:'12px 16px' }}>
        <div style={{ fontSize:13, color:C.muted, marginBottom:12 }}>Who is making a payment?</div>
        {students.map(s => (
          <button key={s.id} onClick={()=>{ setStudId(s.id); setAmount(String(monthlyFee)); setStep(2) }}
            style={{ display:'flex', justifyContent:'space-between', alignItems:'center', width:'100%', background:C.white, border:`1px solid ${C.border}`, borderRadius:12, padding:'12px 14px', marginBottom:8, cursor:'pointer', textAlign:'left' }}>
            <div>
              <div style={{ fontSize:14, fontWeight:600, color:C.text }}>{s.name}</div>
              <div style={{ fontSize:11, color:C.muted }}>Grade {s.grade} · {s.guardian}</div>
            </div>
            <div style={{ fontSize:12, color:C.gcash, fontWeight:600 }}>{peso(monthlyFee)} →</div>
          </button>
        ))}
      </div>
    </div>
  )

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
          {PERIODS.map(p=><option key={p}>{p}</option>)}
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
            <button key={m} onClick={()=>setMethod(m)}
              style={{ padding:'14px', background:method===m?(m==='GCash'?C.gcash:C.amber):C.white, color:method===m?C.white:(m==='GCash'?C.gcash:C.yellowDk), border:`2px solid ${method===m?(m==='GCash'?C.gcash:C.amber):C.border}`, borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
              <span style={{ fontSize:24 }}>{m==='GCash'?'💙':'💵'}</span>{m}
            </button>
          ))}
        </div>

        <label style={lbl}>Note (optional)</label>
        <input value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. Partial, advance…" style={inp}/>

        <button onClick={()=>setStep(3)} disabled={!amount || Number(amount)<=0}
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
              ? <button onClick={startCountdown} disabled={!gcashRef}
                  style={{ width:'100%', padding:'15px', background:gcashRef?`linear-gradient(135deg,${C.gcash},${C.gcashDk})`:'#ccc', color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:gcashRef?'pointer':'not-allowed', boxShadow:gcashRef?`0 4px 14px ${C.gcash}55`:'none' }}>
                  💙 Confirm GCash Payment
                </button>
              : <button onClick={confirmPayment}
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
            <button onClick={confirmPayment}
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
        { label:'Period',  val:period },
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
            { label:'Period',      val:payState.period },
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
function ScreenHistory({ setScreen, txns, students }) {
  const [filter, setFilter] = useState('All')
  const [search, setSearch] = useState('')

  const filtered = txns.filter(t => {
    const name = t.students?.name || students.find(s=>s.id===t.student_id)?.name || ''
    const matchMethod = filter==='All' || t.method===filter || t.period===filter
    const matchSearch = !search || name.toLowerCase().includes(search.toLowerCase()) || (t.ref||'').toLowerCase().includes(search.toLowerCase())
    return matchMethod && matchSearch
  })
  const total = filtered.reduce((a,t)=>a+Number(t.amount),0)

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={()=>setScreen('home')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white, flex:1 }}>Transaction History</span>
        <span style={{ fontSize:12, color:C.amberLt, fontWeight:700 }}>{filtered.length} · {peso(total)}</span>
      </div>
      <div style={{ padding:'12px 16px' }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search student or reference…" style={{ ...inp, marginBottom:10 }}/>
        <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:4 }}>
          {['All','GCash','Cash',...PERIODS.slice(-4)].map(f=>(
            <button key={f} onClick={()=>setFilter(f)}
              style={{ padding:'5px 12px', background:filter===f?C.gcash:C.white, color:filter===f?C.white:C.muted, border:`1px solid ${filter===f?C.gcash:C.border}`, borderRadius:20, fontSize:12, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap', flexShrink:0 }}>
              {f}
            </button>
          ))}
        </div>
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
                <div style={{ fontSize:11, color:C.muted }}>{t.period} · <span style={{ fontFamily:'monospace' }}>{t.ref}</span></div>
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
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SCREEN: STUDENTS
// ═══════════════════════════════════════════════════════════
function ScreenStudents({ setScreen, txns, cfg, students, setPayState }) {
  const [search, setSearch] = useState('')
  const monthlyFee = cfg.rate * cfg.days

  const list = students.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ background:C.navy, padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={()=>setScreen('home')} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.white, padding:0 }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.white }}>Students ({students.length})</span>
      </div>
      <div style={{ padding:'12px 16px' }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search student…" style={inp}/>
      </div>
      <div style={{ padding:'0 16px' }}>
        {list.map(s => {
          const paid    = txns.filter(t=>t.student_id===s.id&&t.period===CURRENT_PERIOD&&t.status==='confirmed').reduce((a,t)=>a+Number(t.amount),0)
          const balance = monthlyFee - paid
          return (
            <div key={s.id} style={{ background:C.white, borderRadius:12, padding:'13px 14px', marginBottom:8, border:`1px solid ${C.border}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{s.name}</div>
                  <div style={{ fontSize:11, color:C.muted }}>Grade {s.grade} · {s.guardian} · {s.contact}</div>
                </div>
                <span style={{ background:C.navy, color:C.amberLt, fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:10 }}>GR.{s.grade}</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:4 }}>
                <span style={{ color:C.muted }}>{CURRENT_PERIOD}</span>
                <span style={{ fontWeight:700, color:balance<=0?C.green:C.red }}>{balance<=0?'PAID ✓':'Owes '+peso(balance)}</span>
              </div>
              <div style={{ background:C.border, borderRadius:4, height:5, overflow:'hidden', marginBottom:10 }}>
                <div style={{ background:balance<=0?C.green:C.gcash, height:'100%', width:`${Math.min(100,(paid/monthlyFee*100))}%`, borderRadius:4 }}/>
              </div>
              <button onClick={()=>{ setPayState({ student_id:s.id, amount:balance>0?balance:monthlyFee }); setScreen('pay') }}
                style={{ width:'100%', padding:'9px', background:balance>0?`linear-gradient(135deg,${C.gcash},${C.gcashDk})`:'#e8f5ee', color:balance>0?C.white:C.green, border:'none', borderRadius:9, fontSize:13, fontWeight:700, cursor:'pointer' }}>
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
// SCREEN: EXPENSES
// ═══════════════════════════════════════════════════════════
function ScreenExpenses({ setScreen, expenses, setExpenses, showToast }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm]         = useState({ period:CURRENT_PERIOD, category:'Fuel', amount:'', description:'', date:today() })
  const [saving, setSaving]     = useState(false)

  const totalFuel  = expenses.filter(e=>e.category==='Fuel').reduce((a,e)=>a+Number(e.amount),0)
  const totalSal   = expenses.filter(e=>e.category==='Salary').reduce((a,e)=>a+Number(e.amount),0)
  const totalMaint = expenses.filter(e=>e.category==='Maintenance').reduce((a,e)=>a+Number(e.amount),0)
  const totalOther = expenses.filter(e=>e.category==='Other').reduce((a,e)=>a+Number(e.amount),0)
  const grand      = totalFuel + totalSal + totalMaint + totalOther

  const handleSave = async () => {
    if (!form.amount || Number(form.amount) <= 0) return
    setSaving(true)
    try {
      const saved = await addExpense({ ...form, amount: Number(form.amount) })
      setExpenses(prev => [saved, ...prev])
      setForm({ period:CURRENT_PERIOD, category:'Fuel', amount:'', description:'', date:today() })
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
        <button onClick={()=>setShowForm(!showForm)} style={{ background:C.amber, border:'none', borderRadius:8, padding:'6px 14px', color:C.navy, fontSize:13, fontWeight:700, cursor:'pointer' }}>
          {showForm?'Cancel':'+ Add'}
        </button>
      </div>

      {showForm && (
        <div style={{ background:C.white, borderBottom:`1px solid ${C.border}`, padding:16 }}>
          <label style={lbl}>Category</label>
          <select value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))} style={inp}>
            {['Fuel','Salary','Maintenance','Other'].map(c=><option key={c}>{c}</option>)}
          </select>
          <label style={lbl}>Period</label>
          <select value={form.period} onChange={e=>setForm(p=>({...p,period:e.target.value}))} style={inp}>
            {PERIODS.map(p=><option key={p}>{p}</option>)}
          </select>
          <label style={lbl}>Amount (₱)</label>
          <input type="number" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="0" style={inp}/>
          <label style={lbl}>Description</label>
          <input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} placeholder="e.g. Fuel refill – Petron" style={inp}/>
          <button onClick={handleSave} disabled={saving}
            style={{ width:'100%', padding:'13px', background:saving?C.muted:`linear-gradient(135deg,${C.navy},${C.navyMd})`, color:C.white, border:'none', borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer', marginTop:12 }}>
            {saving?'Saving…':'Save Expense'}
          </button>
        </div>
      )}

      <div style={{ padding:'16px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
          {[
            { label:'Fuel',        val:totalFuel,  icon:'⛽', color:'#E67E22' },
            { label:'Salary',      val:totalSal,   icon:'👤', color:'#2980B9' },
            { label:'Maintenance', val:totalMaint, icon:'🔧', color:'#8E44AD' },
            { label:'Other',       val:totalOther, icon:'📦', color:C.muted   },
          ].map(k=>(
            <div key={k.label} style={{ background:C.white, borderRadius:12, padding:'12px 14px', border:`1px solid ${C.border}`, borderTop:`3px solid ${k.color}` }}>
              <div style={{ fontSize:18 }}>{k.icon}</div>
              <div style={{ fontSize:16, fontWeight:800, color:k.color, marginTop:4 }}>{peso(k.val)}</div>
              <div style={{ fontSize:11, color:C.muted }}>{k.label}</div>
            </div>
          ))}
        </div>
        <div style={{ background:C.navy, borderRadius:12, padding:'12px 16px', color:C.white, display:'flex', justifyContent:'space-between', marginBottom:16 }}>
          <span style={{ fontSize:14, fontWeight:600 }}>Total Expenses</span>
          <span style={{ fontSize:18, fontWeight:900, color:C.amberLt }}>{peso(grand)}</span>
        </div>

        {expenses.map((e,i) => (
          <div key={i} style={{ background:C.white, borderRadius:10, padding:'11px 14px', marginBottom:8, border:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{e.category} {e.description?`— ${e.description}`:''}</div>
              <div style={{ fontSize:11, color:C.muted }}>{e.period} · {fmtDate(e.date)}</div>
            </div>
            <div style={{ fontSize:14, fontWeight:800, color:C.red }}>{peso(e.amount)}</div>
          </div>
        ))}
        {expenses.length===0 && <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:14 }}>No expenses recorded yet.</div>}
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
            { label:'School Days per Month',  key:'school_days', min:10,  max:26,   step:1   },
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
              <div style={{ fontSize:11, color:C.gcash, marginTop:4 }}>
                Monthly fee = {peso((local.daily_rate||0) * (local.school_days||0))}
              </div>
            </div>
          ))}
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

        <button onClick={handleSave} disabled={saving}
          style={{ width:'100%', padding:'15px', background:saving?C.muted:`linear-gradient(135deg,${C.gcash},${C.gcashDk})`, color:C.white, border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:'pointer', marginBottom:12 }}>
          {saving?'Saving…':'💾 Save Settings'}
        </button>
        <button onClick={onSignOut}
          style={{ width:'100%', padding:'13px', background:C.white, color:C.red, border:`1px solid ${C.red}44`, borderRadius:14, fontSize:14, fontWeight:700, cursor:'pointer' }}>
          Sign Out
        </button>
      </div>
    </div>
  )
}
