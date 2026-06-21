// ============================================================
// src/pdfReports.js
// Generates printable PDF reports for transactions and expenses
// using jsPDF + jspdf-autotable.
// ============================================================

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

const peso = n => 'P' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

function addHeader(doc, title, subtitle, busUnit, gcashName) {
  doc.setFontSize(16)
  doc.setFont(undefined, 'bold')
  doc.text(gcashName || 'Lucky Shining Star Dev. Corp.', 14, 16)
  doc.setFontSize(11)
  doc.setFont(undefined, 'normal')
  doc.text(busUnit || 'NEB 1887', 14, 22)
  doc.setFontSize(13)
  doc.setFont(undefined, 'bold')
  doc.text(title, 14, 32)
  doc.setFontSize(10)
  doc.setFont(undefined, 'normal')
  doc.text(subtitle, 14, 38)
  doc.setDrawColor(200)
  doc.line(14, 41, 196, 41)
}

function addFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setTextColor(150)
    doc.text(`Generated ${new Date().toLocaleString('en-PH')} — Page ${i} of ${pageCount}`, 14, 290)
  }
}

// ── TRANSACTIONS REPORT ───────────────────────────────────────
export function exportTransactionsPDF({ txns, students, periodLabels, startLabel, endLabel, busUnit, gcashName }) {
  const doc = new jsPDF()
  addHeader(doc, 'Transaction Report', `${startLabel} – ${endLabel}`, busUnit, gcashName)

  const rows = txns
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(t => {
      const name = t.students?.name || students.find(s => s.id === t.student_id)?.name || '—'
      return [
        periodLabels[t.period] || t.period,
        name,
        t.method,
        t.ref || '—',
        new Date(t.date).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }),
        peso(t.amount),
      ]
    })

  autoTable(doc, {
    startY: 46,
    head: [['Period', 'Student', 'Method', 'Reference', 'Date', 'Amount']],
    body: rows,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [0, 125, 255] },
    columnStyles: { 5: { halign: 'right' } },
  })

  const total = txns.reduce((a, t) => a + Number(t.amount), 0)
  const gcashTotal = txns.filter(t => t.method === 'GCash').reduce((a, t) => a + Number(t.amount), 0)
  const cashTotal = txns.filter(t => t.method === 'Cash').reduce((a, t) => a + Number(t.amount), 0)

  const finalY = doc.lastAutoTable.finalY + 8
  doc.setFontSize(10)
  doc.setFont(undefined, 'bold')
  doc.text(`Total Collected: ${peso(total)}`, 14, finalY)
  doc.setFont(undefined, 'normal')
  doc.text(`GCash: ${peso(gcashTotal)}   |   Cash: ${peso(cashTotal)}   |   Transactions: ${txns.length}`, 14, finalY + 6)

  addFooter(doc)
  doc.save(`Transactions_${startLabel}_to_${endLabel}.pdf`.replace(/\s+/g, '_'))
}

// ── EXPENSES REPORT ────────────────────────────────────────────
export function exportExpensesPDF({ expenses, periodLabels, startLabel, endLabel, busUnit, gcashName }) {
  const doc = new jsPDF()
  addHeader(doc, 'Expense Report', `${startLabel} – ${endLabel}`, busUnit, gcashName)

  const rows = expenses
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(e => [
      periodLabels[e.period] || e.period,
      e.category,
      e.description || '—',
      new Date(e.date).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }),
      peso(e.amount),
    ])

  autoTable(doc, {
    startY: 46,
    head: [['Period', 'Category', 'Description', 'Date', 'Amount']],
    body: rows,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [240, 165, 0] },
    columnStyles: { 4: { halign: 'right' } },
  })

  const byCat = {}
  expenses.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount) })
  const grandTotal = Object.values(byCat).reduce((a, v) => a + v, 0)

  let finalY = doc.lastAutoTable.finalY + 8
  doc.setFontSize(10)
  doc.setFont(undefined, 'bold')
  doc.text(`Grand Total: ${peso(grandTotal)}`, 14, finalY)
  doc.setFont(undefined, 'normal')
  finalY += 6
  Object.entries(byCat).forEach(([cat, amt]) => {
    doc.text(`${cat}: ${peso(amt)}`, 14, finalY)
    finalY += 5
  })

  addFooter(doc)
  doc.save(`Expenses_${startLabel}_to_${endLabel}.pdf`.replace(/\s+/g, '_'))
}
