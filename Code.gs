/**
 * ระบบขอใบลา (Google Apps Script)
 * ลำดับ: พนักงานยื่น → หัวหน้า → MGR → FM → HR (ออกใบลา)
 *
 * วิธีใช้: Google Sheet > Extensions > Apps Script > วางไฟล์นี้ทั้งไฟล์ (แทนของเดิม)
 * 1) แก้ HR_EMAIL, HR_PASSCODE (และ APP_URL ถ้าต้องการลิงก์ในอีเมล)
 * 2) กด Run ฟังก์ชัน setup() 1 ครั้ง (เพิ่มคอลัมน์ใหม่ในชีต Requests และสร้างชีต Balances ให้อัตโนมัติ)
 * 3) Deploy > Manage deployments > แก้ไข > New version (Execute as: Me | Who has access: Anyone)
 *
 * ชีตที่ใช้:
 *   Employees (รายชื่อ + PIN + ผู้อนุมัติของแต่ละคน)
 *   Requests  (ใบลาทั้งหมด)
 *   Balances  (สิทธิ์วันลาต่อปีของพนักงานแต่ละคน HR แก้ในแอปหรือแก้ในชีตนี้ได้)
 * ไฟล์แนบเก็บในโฟลเดอร์ Drive ชื่อ LeaveAttachments (ของเจ้าของสคริปต์) เปิดดูผ่านแอปเท่านั้น
 */
const HR_EMAIL = '@kurota-th.com';  // อีเมล HR (หลายคนคั่นด้วยคอมมา) รับแจ้งเมื่อใบลาถึงขั้น HR
const HR_PASSCODE = '123456';             // รหัสเข้าหน้า HR (เปลี่ยนก่อนใช้งานจริง)
const APP_URL = '';                       // URL ของแอป เช่น 'https://ชื่อ.github.io/HR/' (ใช้ทำลิงก์ในอีเมล ไม่ใส่ก็ได้)

const EMP_SHEET = 'Employees', REQ_SHEET = 'Requests', BAL_SHEET = 'Balances';
const EMP_HEADERS = ['รหัสพนักงาน', 'ชื่อ-นามสกุล', 'แผนก', 'เบอร์ติดต่อ', 'สถานะ', 'PIN (hash)', 'ต้องเปลี่ยน PIN',
  'รหัสหัวหน้า', 'รหัส MGR', 'รหัส FM', 'อีเมล', 'วันเริ่มงาน', 'สิทธิ์พักร้อนต่อปี (วัน)', 'รูป (Drive ID)'];
const REQ_HEADERS = ['เลขที่', 'เวลายื่น', 'clientId', 'รหัสพนักงาน', 'ชื่อ-นามสกุล', 'แผนก', 'ประเภทการลา',
  'วันที่เริ่ม', 'วันที่สิ้นสุด', 'จำนวนวัน', 'เหตุผล', 'เบอร์ติดต่อ', 'สถานะ', 'ขั้นปัจจุบัน',
  'เส้นทางอนุมัติ', 'ออกใบลา', 'ออกใบลาเมื่อ', 'หมายเหตุ HR', 'ไฟล์แนบ',
  // คอลัมน์ที่เพิ่มใหม่ (ลาครึ่งวัน / รายชั่วโมง / ย้อนหลัง)
  'รูปแบบการลา', 'กะ', 'เวลาเริ่ม', 'เวลาสิ้นสุด', 'ชั่วโมงลา', 'ย้อนหลัง'];
const R = {}; REQ_HEADERS.forEach((h, i) => R[h] = i);
const BAL_HEADERS = ['รหัสพนักงาน', 'ปี (ค.ศ.)', 'สิทธิ์ลาป่วย (วัน)', 'สิทธิ์ลากิจ (วัน)', 'สิทธิ์พักร้อน (วัน)',
  'ปรับยอดใช้ไป-ลาป่วย', 'ปรับยอดใช้ไป-ลากิจ', 'ปรับยอดใช้ไป-พักร้อน', 'หมายเหตุ'];

const E_ON = 'ใช้งาน', E_OFF = 'ไม่ใช้งาน';
const S_HR = 'รอ HR ออกใบลา', S_DONE = 'ออกใบลาแล้ว', S_NO = 'ไม่อนุมัติ', S_CANCEL = 'ยกเลิก';
const TOKEN_DAYS = 30, MAX_FAILS = 5, LOCK_MIN = 15;

// ไฟล์แนบ
const PHOTO_FOLDER = 'EmployeePhotos';
const ATTACH_FOLDER = 'LeaveAttachments', MAX_FILES = 5, MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
const RETRO_REQUIRE_FILE = false; // true = ลาย้อนหลังต้องแนบเอกสารอย่างน้อย 1 ไฟล์

// กะการทำงาน: slots = ชั่วโมงทำงาน 8 ช่อง (ไม่รวมช่วงพัก) 1 วันทำงาน = 8 ชม.
//   กะเช้า 08:00-12:00 / 13:00-17:00     กะดึก 20:00-00:00 / 01:00-05:00
const DAY_HOURS = 8, MIN_HOURS = 1;
const SHIFTS = {
  day: { name: 'กะเช้า', slots: [8, 9, 10, 11, 13, 14, 15, 16] },
  night: { name: 'กะดึก', slots: [20, 21, 22, 23, 1, 2, 3, 4] }
};
const MODE_TH = { full: 'เต็มวัน', half: 'ครึ่งวัน', hour: 'รายชั่วโมง' };
const MODE_KEY = { 'เต็มวัน': 'full', 'ครึ่งวัน': 'half', 'รายชั่วโมง': 'hour' };

// สิทธิ์เริ่มต้นเมื่อ HR ยังไม่ได้กำหนดในชีต Balances ('' = ยังไม่กำหนด) เช่น { sick: 30, biz: 3, vac: 6 }
const DEFAULT_QUOTA = { sick: '', biz: '', vac: '' };
const CATS = ['sick', 'biz', 'vac'];

/** กด Run 1 ครั้งหลังวางโค้ด เพื่อให้สิทธิ์ (Sheet + อีเมล + Drive) และสร้างชีตให้พร้อม */
function setup() {
  const es = empSheet_();
  es.getRange(1, 1, 1, EMP_HEADERS.length).setValues([EMP_HEADERS]);
  const rs = reqSheet_();
  rs.getRange(1, 1, 1, REQ_HEADERS.length).setValues([REQ_HEADERS]); // เพิ่มหัวคอลัมน์ใหม่ (ข้อมูลเดิมไม่หาย)
  rs.getRange('V:W').setNumberFormat('@'); // เวลาเริ่ม/สิ้นสุด เก็บเป็นข้อความ กัน Sheets แปลงเป็นเวลา
  const bs = balSheet_();
  bs.getRange(1, 1, 1, BAL_HEADERS.length).setValues([BAL_HEADERS]);
  secret_();
  attachFolder_();
  MailApp.getRemainingDailyQuota();
  Logger.log('พร้อมใช้งาน: ชีต Employees, Requests, Balances และโฟลเดอร์ไฟล์แนบพร้อมแล้ว');
}

// ---------- helpers ----------
function sheet_(name, headers, textCols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    (textCols || []).forEach(c => sh.getRange(c + ':' + c).setNumberFormat('@'));
  }
  return sh;
}
function empSheet_() { return sheet_(EMP_SHEET, EMP_HEADERS, ['A', 'D', 'H', 'I', 'J']); }
function reqSheet_() { return sheet_(REQ_SHEET, REQ_HEADERS, ['D', 'H', 'I', 'V', 'W']); }
function balSheet_() { return sheet_(BAL_SHEET, BAL_HEADERS, ['A']); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function esc_(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function str_(x) { return String(x === null || x === undefined ? '' : x).trim(); }
function dstr_(x) { return x instanceof Date ? Utilities.formatDate(x, 'Asia/Bangkok', 'yyyy-MM-dd') : String(x); }
function tstr_(x) { return x instanceof Date ? Utilities.formatDate(x, 'Asia/Bangkok', 'HH:mm') : str_(x); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function parseJson_(s, d) { try { return JSON.parse(s); } catch (e) { return d; } }
function nowIso_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss"); }
function todayStr_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }
function thisYear_() { return Number(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy')); }
function numOrNull_(x) { if (x === '' || x === null || x === undefined) return null; const n = Number(x); return isNaN(n) ? null : n; }
function normYear_(y) { y = Number(y); return y > 2400 ? y - 543 : y; } // กันกรอกปี พ.ศ. ในชีต
function calcDays_(s, e) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(s) || !re.test(e) || e < s) return 0;
  const a = s.split('-').map(Number), b = e.split('-').map(Number);
  return (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000 + 1;
}

// ---------- ลาครึ่งวัน / รายชั่วโมง ----------
// ตรวจและคำนวณฝั่งเซิร์ฟเวอร์ (ไม่เชื่อค่าจากแอป) คืน { mode, days, hours, shift, tStart, tEnd, i, n } หรือ { error, message }
function calcLeave_(d) {
  const re = /^\d{4}-\d{2}-\d{2}$/, start = String(d.start), end = String(d.end);
  if (!re.test(start) || !re.test(end) || end < start) return { error: 'invalid dates', message: 'วันที่ไม่ถูกต้อง' };
  const mode = (d.mode === 'half' || d.mode === 'hour') ? d.mode : 'full';
  if (mode === 'full') {
    const days = calcDays_(start, end);
    return { mode: 'full', days: days, hours: days * DAY_HOURS, shift: '', tStart: '', tEnd: '' };
  }
  if (start !== end) return { error: 'partial', message: 'ลาครึ่งวัน/รายชั่วโมง เลือกได้เฉพาะวันเดียว' };
  const sh = SHIFTS[d.shift];
  if (!sh) return { error: 'shift', message: 'กรุณาเลือกกะการทำงาน' };
  let i, n;
  if (mode === 'half') {
    if (d.part !== 'am' && d.part !== 'pm') return { error: 'part', message: 'กรุณาเลือกช่วงที่ลา' };
    i = d.part === 'pm' ? 4 : 0; n = 4;
  } else {
    if (str_(d.type).slice(0, 2) !== '02') return { error: 'hour type', message: 'ลารายชั่วโมงใช้ได้เฉพาะลากิจ' };
    i = sh.slots.indexOf(Number(String(d.from || '').slice(0, 2)));
    n = Number(d.hours);
    if (i < 0 || !(n >= MIN_HOURS) || n !== Math.floor(n) || i + n > sh.slots.length) return { error: 'hours', message: 'ช่วงเวลาที่ลาไม่ถูกต้อง (ขั้นต่ำ ' + MIN_HOURS + ' ชั่วโมง และต้องอยู่ในเวลาทำงานของกะ)' };
  }
  return { mode: mode, days: n / DAY_HOURS, hours: n, shift: d.shift,
    tStart: pad2_(sh.slots[i]) + ':00', tEnd: pad2_((sh.slots[i + n - 1] + 1) % 24) + ':00', i: i, n: n };
}
// ข้อมูลรูปแบบการลาของแถวในชีต (แถวเก่าที่ไม่มีคอลัมน์ใหม่ = เต็มวัน หรือครึ่งวันถ้า 0.5 วัน)
function meta_(r) {
  const days = Number(r[R['จำนวนวัน']]) || 0, sn = str_(r[R['กะ']]), hv = r[R['ชั่วโมงลา']];
  return {
    mode: MODE_KEY[str_(r[R['รูปแบบการลา']])] || (days === 0.5 ? 'half' : 'full'),
    shift: sn === SHIFTS.night.name ? 'night' : (sn === SHIFTS.day.name ? 'day' : ''),
    tStart: tstr_(r[R['เวลาเริ่ม']]), tEnd: tstr_(r[R['เวลาสิ้นสุด']]),
    hours: (hv === '' || hv === null || hv === undefined || isNaN(Number(hv))) ? days * DAY_HOURS : Number(hv),
    retro: str_(r[R['ย้อนหลัง']]) === 'ย้อนหลัง'
  };
}
function whenTxt_(m) {
  if (m.mode === 'full') return '';
  const sn = m.shift ? SHIFTS[m.shift].name : '', t = (m.tStart && m.tEnd) ? m.tStart + '-' + m.tEnd : '';
  return m.mode === 'half' ? 'ครึ่งวัน' + (sn ? ' (' + sn + ')' : '') + (t ? ' ' + t : '')
    : 'รายชั่วโมง' + (sn ? ' (' + sn + ')' : '') + (t ? ' ' + t : '') + ' รวม ' + m.hours + ' ชม.';
}
// ช่วงเวลาที่ใบลาครอบอยู่ในวันนั้น (null = ทั้งวัน)
function occ_(r) {
  const m = meta_(r);
  if (m.mode === 'full' || !m.tStart || !SHIFTS[m.shift]) return null;
  const i = SHIFTS[m.shift].slots.indexOf(Number(m.tStart.slice(0, 2)));
  return i < 0 ? null : { shift: m.shift, i: i, n: Number(m.hours) || 0 };
}
// กันลาซ้อนทับ: คืนเลขที่ใบลาที่ชน หรือ '' ถ้าไม่ชน (ใบที่ไม่อนุมัติ/ยกเลิกไม่นับ)
function conflict_(empId, start, end, c) {
  const rows = reqRows_();
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k].r;
    if (str_(r[R['รหัสพนักงาน']]) !== empId) continue;
    const st = r[R['สถานะ']];
    if (st === S_NO || st === S_CANCEL) continue;
    if (dstr_(r[R['วันที่สิ้นสุด']]) < start || dstr_(r[R['วันที่เริ่ม']]) > end) continue;
    const ex = occ_(r);
    if (c.mode === 'full' || !ex || (ex.shift === c.shift && !(ex.i + ex.n <= c.i || c.i + c.n <= ex.i))) return String(r[R['เลขที่']]);
  }
  return '';
}

// ---------- ไฟล์แนบ ----------
function attachFolder_() {
  const it = DriveApp.getFoldersByName(ATTACH_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ATTACH_FOLDER);
}
// ตรวจไฟล์ทั้งหมดก่อน แล้วค่อยบันทึกลง Drive คืน { files: [{id,name,type}] } หรือ { error }
function saveFiles_(no, files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_FILES) return { error: 'แนบได้สูงสุด ' + MAX_FILES + ' ไฟล์' };
  const ready = [];
  for (let i = 0; i < list.length; i++) {
    const name = str_(list[i].name).replace(/[\\\/:*?"<>|]/g, '_').slice(0, 80) || 'file';
    const type = FILE_TYPES[name.split('.').pop().toLowerCase()];
    if (!type) return { error: 'ไม่รองรับชนิดไฟล์: ' + name };
    let bytes;
    try { bytes = Utilities.base64Decode(String(list[i].data || '')); } catch (e) { return { error: 'อ่านไฟล์ไม่ได้: ' + name }; }
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) return { error: 'ไฟล์ว่างหรือใหญ่เกิน 5 MB: ' + name };
    ready.push({ name: name, type: type, bytes: bytes });
  }
  if (!ready.length) return { files: [] };
  const folder = attachFolder_(), out = [];
  ready.forEach((f, i) => {
    const file = folder.createFile(Utilities.newBlob(f.bytes, f.type, no + '_' + (i + 1) + '_' + f.name));
    out.push({ id: file.getId(), name: f.name, type: f.type });
  });
  return { files: out };
}
// เปิดไฟล์แนบ: เจ้าของใบลา / ผู้อนุมัติในสายของใบนั้น (ใช้ token) หรือ HR (ใช้ passcode)
function file_(d) {
  let emp = null;
  if (d.passcode !== undefined) {
    if (d.passcode !== HR_PASSCODE) { Utilities.sleep(1500); return { ok: false, error: 'auth' }; }
  } else {
    emp = verifyToken_(d.token);
    if (!emp) return { ok: false, error: 'auth' };
  }
  const id = str_(d.id);
  const o = reqRows_().filter(x => parseJson_(x.r[R['ไฟล์แนบ']], []).some(f => f.id === id))[0];
  if (!o) return { ok: false, error: 'not found', message: 'ไม่พบไฟล์' };
  if (emp) {
    const steps = parseJson_(o.r[R['เส้นทางอนุมัติ']], []);
    const allowed = str_(o.r[R['รหัสพนักงาน']]) === emp.id || steps.some(s => s.id === emp.id);
    if (!allowed) return { ok: false, error: 'forbidden', message: 'ไม่มีสิทธิ์ดูไฟล์นี้' };
  }
  const meta = parseJson_(o.r[R['ไฟล์แนบ']], []).filter(f => f.id === id)[0];
  const blob = DriveApp.getFileById(id).getBlob();
  return { ok: true, name: meta.name, type: meta.type, data: Utilities.base64Encode(blob.getBytes()) };
}

// ---------- วันลาคงเหลือ (Balances) ----------
// สิทธิ์ต่อปีของพนักงานแต่ละคนอยู่ในชีต Balances (1 แถวต่อคนต่อปี) HR แก้ในแอปหรือพิมพ์ในชีตได้
// ถ้าปีนั้นยังไม่มีแถว: ลาพักร้อนใช้ค่าในคอลัมน์ "สิทธิ์พักร้อนต่อปี" ของชีต Employees, ที่เหลือใช้ DEFAULT_QUOTA
function balRows_(year) {
  const v = balSheet_().getDataRange().getValues(), out = {};
  for (let i = 1; i < v.length; i++) {
    const r = v[i], id = str_(r[0]);
    if (!id || normYear_(r[1]) !== year) continue;
    out[id] = { row: i + 1, quota: { sick: numOrNull_(r[2]), biz: numOrNull_(r[3]), vac: numOrNull_(r[4]) },
      adj: { sick: numOrNull_(r[5]) || 0, biz: numOrNull_(r[6]) || 0, vac: numOrNull_(r[7]) || 0 }, note: str_(r[8]) };
  }
  return out;
}
// วันลาที่ใช้ไป (อนุมัติครบแล้ว) และที่รออนุมัติ แยกตามพนักงานและประเภท นับตามปีของวันที่เริ่มลา
function usage_(year) {
  const y = String(year), u = {};
  reqRows_().forEach(o => {
    const r = o.r;
    if (dstr_(r[R['วันที่เริ่ม']]).slice(0, 4) !== y) return;
    const cat = CARD_CAT[str_(r[R['ประเภทการลา']]).slice(0, 2)];
    if (!cat) return;
    const id = str_(r[R['รหัสพนักงาน']]), st = r[R['สถานะ']], days = Number(r[R['จำนวนวัน']]) || 0;
    const e = u[id] || (u[id] = { sick: { used: 0, pend: 0 }, biz: { used: 0, pend: 0 }, vac: { used: 0, pend: 0 } });
    if (st === S_HR || st === S_DONE) e[cat].used += days;
    else if (isOpen_(st)) e[cat].pend += days;
  });
  return u;
}
function balanceFor_(emp, bRow, use) {
  const out = {};
  CATS.forEach(c => {
    let q = bRow ? bRow.quota[c] : null;
    if (q === null || q === undefined) q = (c === 'vac' && emp.vac !== '' && emp.vac !== null) ? emp.vac : numOrNull_(DEFAULT_QUOTA[c]);
    const adj = bRow ? bRow.adj[c] : 0, u = (use && use[c]) || { used: 0, pend: 0 }, used = u.used + adj;
    out[c] = { quota: q, adj: adj, used: used, pending: u.pend, remain: q === null ? null : q - used };
  });
  return out;
}
function balance_(d) { // พนักงานดูของตัวเอง
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  const year = normYear_(d.year || thisYear_());
  return { ok: true, year: year, bal: balanceFor_(emp, balRows_(year)[emp.id], usage_(year)[emp.id]) };
}

// ---------- รูปพนักงาน / ใบลา (Leave Card) ----------
function savePhoto_(empId, data, oldId) {
  let bytes;
  try { bytes = Utilities.base64Decode(String(data)); } catch (e) { return { error: 'อ่านรูปไม่ได้' }; }
  if (!bytes.length || bytes.length > 1024 * 1024) return { error: 'รูปว่างหรือใหญ่เกิน 1 MB' };
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
  const f = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', 'emp_' + empId + '_' + Date.now() + '.jpg'));
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  return { id: f.getId() };
}
// พนักงาน (token) ดูของตัวเอง / HR (passcode + empId) ดูของใครก็ได้
function authSubject_(d) {
  if (d.passcode !== undefined) {
    if (d.passcode !== HR_PASSCODE) { Utilities.sleep(1500); return null; }
    return { emp: findEmp_(d.empId) };
  }
  const e = verifyToken_(d.token);
  return e ? { emp: e } : null;
}
function photo_(d) {
  const a = authSubject_(d);
  if (!a) return { ok: false, error: 'auth' };
  if (!a.emp || !a.emp.photo) return { ok: false, error: 'none' };
  try { return { ok: true, id: a.emp.photo, data: Utilities.base64Encode(DriveApp.getFileById(a.emp.photo).getBlob().getBytes()) }; }
  catch (e) { return { ok: false, error: 'none' }; }
}
const CARD_CAT = { '01': 'sick', '02': 'biz', '03': 'vac', '12': 'vac' };
function dmy_(ymd) { ymd = String(ymd); return ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(2, 4); }
function stepState_(steps, role, cur, open, issued) {
  const i = steps.findIndex(s => s.role === role);
  if (i < 0) return '-';
  if (role === 'HR') return issued ? 'ok' : (open && i === cur) ? 'wait' : '-';
  if (steps[i].decision === 'ok') return 'ok';
  if (steps[i].decision === 'no') return 'no';
  return (open && i === cur) ? 'wait' : '-';
}
function card_(d) {
  const a = authSubject_(d);
  if (!a) return { ok: false, error: 'auth' };
  const emp = a.emp;
  if (!emp) return { ok: false, error: 'not found' };
  const year = String(d.year || thisYear_()), tot = { sick: 0, biz: 0, vac: 0, other: 0 };
  const rows = reqRows_().filter(o => str_(o.r[R['รหัสพนักงาน']]) === emp.id && dstr_(o.r[R['วันที่เริ่ม']]).slice(0, 4) === year).map(o => {
    const r = o.r, st = r[R['สถานะ']], steps = parseJson_(r[R['เส้นทางอนุมัติ']], []), cur = Number(r[R['ขั้นปัจจุบัน']]) || 0;
    const open = isOpen_(st), issued = str_(r[R['ออกใบลา']]) === 'ออกแล้ว';
    const code = str_(r[R['ประเภทการลา']]).slice(0, 2), cat = CARD_CAT[code] || 'other', days = Number(r[R['จำนวนวัน']]) || 0;
    if (st === S_HR || st === S_DONE) tot[cat] += days; // นับเฉพาะใบที่อนุมัติครบแล้ว
    const files = parseJson_(r[R['ไฟล์แนบ']], []);
    const okAt = steps.filter(s => s.role !== 'HR' && s.decision === 'ok' && s.at).map(s => String(s.at).slice(0, 10)).sort();
    const ts = r[R['เวลายื่น']], m = meta_(r);
    return { code: code, cat: cat, days: days, cancelled: st === S_CANCEL, status: st,
      mode: m.mode, shift: m.shift, tStart: m.tStart, tEnd: m.tEnd, hours: m.hours, retro: m.retro, when: whenTxt_(m),
      filed: ts instanceof Date ? Utilities.formatDate(ts, 'Asia/Bangkok', 'dd/MM/yy') : '',
      start: dmy_(dstr_(r[R['วันที่เริ่ม']])), end: dmy_(dstr_(r[R['วันที่สิ้นสุด']])), reason: str_(r[R['เหตุผล']]),
      health: code === '01' ? (files.length ? 'yes' : 'no') : '', // ลาป่วย: มีไฟล์แนบ = มีใบรับรองแพทย์
      sup: stepState_(steps, 'หัวหน้า', cur, open, issued), mgr: stepState_(steps, 'MGR', cur, open, issued),
      fm: stepState_(steps, 'FM', cur, open, issued), hr: stepState_(steps, 'HR', cur, open, issued),
      approvedOn: okAt.length ? dmy_(okAt[okAt.length - 1]) : '' };
  });
  const y = Number(year);
  return { ok: true, year: y, today: Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy'),
    emp: { id: emp.id, name: emp.name, dept: emp.dept, startDate: emp.start, vac: emp.vac, photo: emp.photo }, rows: rows, tot: tot,
    bal: balanceFor_(emp, balRows_(y)[emp.id], usage_(y)[emp.id]) };
}

// ---------- รหัสลับ / token / PIN ----------
function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SECRET', s); }
  return s;
}
function hex_(bytes) { return bytes.map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join(''); }
function sign_(str) { return hex_(Utilities.computeHmacSha256Signature(str, secret_())); }
function hashPin_(empId, pin) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret_() + '|' + empId + '|' + pin)); }
function validPin_(pin) { return /^\d{4,8}$/.test(String(pin || '')); }
function makeToken_(emp) {
  const body = emp.id + '|' + (Date.now() + TOKEN_DAYS * 86400000) + '|' + emp.hash.slice(0, 8);
  return Utilities.base64EncodeWebSafe(body, Utilities.Charset.UTF_8) + '.' + sign_(body);
}
function verifyToken_(tok) {
  try {
    const parts = String(tok || '').split('.');
    if (parts.length !== 2) return null;
    const body = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    if (sign_(body) !== parts[1]) return null;
    const f = body.split('|');
    if (Date.now() > Number(f[1])) return null;
    const emp = findEmp_(f[0]);
    if (!emp || !emp.active || !emp.hash || emp.hash.slice(0, 8) !== f[2]) return null;
    return emp;
  } catch (e) { return null; }
}

// ---------- พนักงาน ----------
function emps_() {
  const v = empSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) {
    const r = v[i], id = str_(r[0]);
    if (!id) continue;
    out.push({ row: i + 1, id: id, name: str_(r[1]), dept: str_(r[2]), phone: str_(r[3]),
      active: (str_(r[4]) || E_ON) === E_ON, hash: str_(r[5]), mustChange: str_(r[6]) === 'ใช่',
      sup: str_(r[7]), mgr: str_(r[8]), fm: str_(r[9]), email: str_(r[10]),
      start: r[11] ? dstr_(r[11]) : '', vac: (r[12] === '' || r[12] == null || isNaN(Number(r[12]))) ? '' : Number(r[12]), photo: str_(r[13]) });
  }
  return out;
}
function findEmp_(id) {
  id = str_(id);
  const all = emps_();
  for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

// ลำดับอนุมัติของพนักงานแต่ละคน: หัวหน้า → MGR → FM → HR (ข้ามขั้นที่ไม่ได้กำหนดหรือเป็นตัวเอง)
function buildChain_(emp) {
  const steps = [];
  [['หัวหน้า', emp.sup], ['MGR', emp.mgr], ['FM', emp.fm]].forEach(p => {
    const id = str_(p[1]);
    if (!id || id === emp.id) return;
    const a = findEmp_(id);
    if (a && a.active) steps.push({ role: p[0], id: id, name: a.name });
  });
  steps.push({ role: 'HR', id: '', name: 'ฝ่ายบุคคล' });
  return steps;
}
function statusFor_(steps, i) {
  const s = steps[i];
  return s.role === 'HR' ? S_HR : 'รอ' + s.role + 'อนุมัติ';
}
const isOpen_ = st => String(st).indexOf('รอ') === 0;

// ---------- รายการใบลา ----------
function reqRows_() {
  const v = reqSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) if (v[i][R['เลขที่']]) out.push({ row: i + 1, r: v[i] });
  return out;
}
function item_(r) {
  const steps = parseJson_(r[R['เส้นทางอนุมัติ']], []), m = meta_(r);
  return {
    no: r[R['เลขที่']], ts: r[R['เวลายื่น']], empId: str_(r[R['รหัสพนักงาน']]), name: r[R['ชื่อ-นามสกุล']],
    dept: r[R['แผนก']], type: r[R['ประเภทการลา']], start: dstr_(r[R['วันที่เริ่ม']]), end: dstr_(r[R['วันที่สิ้นสุด']]),
    days: r[R['จำนวนวัน']], reason: r[R['เหตุผล']], phone: r[R['เบอร์ติดต่อ']], status: r[R['สถานะ']],
    mode: m.mode, shift: m.shift, tStart: m.tStart, tEnd: m.tEnd, hours: m.hours, retro: m.retro,
    cur: Number(r[R['ขั้นปัจจุบัน']]) || 0,
    steps: steps.map(s => ({ role: s.role, name: s.name || '', decision: s.decision || '', at: s.at || '', note: s.note || '' })),
    issued: str_(r[R['ออกใบลา']]) === 'ออกแล้ว', issuedAt: r[R['ออกใบลาเมื่อ']] ? String(r[R['ออกใบลาเมื่อ']]) : '',
    hrNote: r[R['หมายเหตุ HR']] || '',
    files: parseJson_(r[R['ไฟล์แนบ']], []).map(f => ({ id: f.id, name: f.name, type: f.type }))
  };
}
function infoFromRow_(r) {
  const m = meta_(r);
  return { name: r[R['ชื่อ-นามสกุล']], empId: str_(r[R['รหัสพนักงาน']]), type: String(r[R['ประเภทการลา']]),
    start: dstr_(r[R['วันที่เริ่ม']]), end: dstr_(r[R['วันที่สิ้นสุด']]), days: r[R['จำนวนวัน']], reason: String(r[R['เหตุผล']]),
    when: whenTxt_(m), retro: m.retro };
}
// ใบที่รอให้ emp อนุมัติ (ขั้นปัจจุบันเป็นของ emp และไม่ใช่ขั้น HR)
function waitingFor_(emp) {
  return reqRows_().filter(o => {
    const r = o.r, steps = parseJson_(r[R['เส้นทางอนุมัติ']], []), s = steps[Number(r[R['ขั้นปัจจุบัน']]) || 0];
    return isOpen_(r[R['สถานะ']]) && s && s.role !== 'HR' && s.id === emp.id && str_(r[R['รหัสพนักงาน']]) !== emp.id;
  });
}

function upcomingFor_(emp) { // ใบที่ยังไม่ถึงขั้นของ emp (MGR/FM) แต่จะมาถึง ใช้แจ้งรับทราบ
  return reqRows_().filter(o => {
    const r = o.r, steps = parseJson_(r[R['เส้นทางอนุมัติ']], []), cur = Number(r[R['ขั้นปัจจุบัน']]) || 0;
    return isOpen_(r[R['สถานะ']]) && str_(r[R['รหัสพนักงาน']]) !== emp.id &&
      steps.some((s, i) => i > cur && s.role !== 'HR' && s.id === emp.id);
  });
}

function notifyStep_(step, d, no, fyi) {
  try {
    const to = [];
    if (step.role === 'HR') HR_EMAIL.split(',').forEach(x => { if (str_(x)) to.push(str_(x)); });
    else { const a = findEmp_(step.id); if (a && a.email) to.push(a.email); }
    if (!to.length) return;
    const html = '<div style="font-family:sans-serif;font-size:15px"><p><b>' +
      (fyi ? 'มีใบลาใหม่เพื่อรับทราบ (' + esc_(step.role) + ') จะถึงขั้นของคุณเมื่อผู้อนุมัติก่อนหน้าอนุมัติแล้ว'
        : step.role === 'HR' ? 'ใบลาอนุมัติครบแล้ว รอ HR ออกใบลา' : 'มีใบลารอการอนุมัติของคุณ (' + esc_(step.role) + ')') + '</b> ' + esc_(no) + '</p>' +
      '<table cellpadding="4"><tr><td>พนักงาน</td><td>' + esc_(d.name) + ' (' + esc_(d.empId) + ')</td></tr>' +
      '<tr><td>ประเภท</td><td>' + esc_(d.type) + (d.retro ? ' <b style="color:#a86a00">(ลาย้อนหลัง)</b>' : '') + '</td></tr>' +
      '<tr><td>ช่วงวันที่</td><td>' + esc_(d.start) + ' ถึง ' + esc_(d.end) + ' (' + d.days + ' วัน)</td></tr>' +
      (d.when ? '<tr><td>เวลา</td><td>' + esc_(d.when) + '</td></tr>' : '') +
      '<tr><td>เหตุผล</td><td>' + esc_(d.reason) + '</td></tr></table>' +
      (APP_URL ? '<p><a href="' + APP_URL + '" style="background:#0f4c5c;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px">เปิดแอป</a></p>' : '') + '</div>';
    MailApp.sendEmail({ to: to.join(','), subject: '[ใบลา] ' + (fyi ? 'รับทราบ: ' : step.role === 'HR' ? 'รอออกใบลา: ' : 'รออนุมัติ: ') + d.name + ' - ' + d.type, htmlBody: html });
  } catch (e) {}
}

// ---------- doPost ----------
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const d = JSON.parse(e.postData.contents);
    let res;
    switch (d.action) {
      case 'login': res = login_(d); break;
      case 'me': res = me_(d); break;
      case 'changePin': res = changePin_(d); break;
      case 'submit': res = submit_(d); break;
      case 'mine': res = mine_(d); break;
      case 'inbox': res = inbox_(d); break;
      case 'decide': res = decide_(d); break;
      case 'cancel': res = cancel_(d); break;
      case 'file': res = file_(d); break;
      case 'card': res = card_(d); break;
      case 'photo': res = photo_(d); break;
      case 'balance': res = balance_(d); break;
      default: res = hr_(d);
    }
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
function doGet() { return json_({ ok: true, service: 'leave-request' }); }

// ---------- พนักงาน: ล็อกอิน / โปรไฟล์ / เปลี่ยน PIN ----------
function profile_(emp) {
  const all = emps_();
  return { emp: { id: emp.id, name: emp.name, dept: emp.dept, phone: emp.phone, mustChange: emp.mustChange, photo: emp.photo },
    chain: buildChain_(emp).map(c => ({ role: c.role, name: c.name })),
    isApprover: all.some(e => e.active && (e.sup === emp.id || e.mgr === emp.id || e.fm === emp.id)),
    inbox: waitingFor_(emp).length, upcoming: upcomingFor_(emp).length };
}
function login_(d) {
  const id = str_(d.empId), pin = str_(d.pin);
  if (!id || !pin) return { ok: false, error: 'missing' };
  const cache = CacheService.getScriptCache(), key = 'fail:' + id;
  const fails = Number(cache.get(key) || 0);
  if (fails >= MAX_FAILS) return { ok: false, error: 'locked' };
  const emp = findEmp_(id);
  if (!emp || !emp.active || !emp.hash || emp.hash !== hashPin_(id, pin)) {
    cache.put(key, String(fails + 1), LOCK_MIN * 60);
    Utilities.sleep(800);
    return { ok: false, error: 'auth' };
  }
  cache.remove(key);
  const p = profile_(emp); p.ok = true; p.token = makeToken_(emp);
  return p;
}
function me_(d) {
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  const p = profile_(emp); p.ok = true;
  return p;
}
function changePin_(d) {
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  if (emp.hash !== hashPin_(emp.id, str_(d.oldPin))) { Utilities.sleep(800); return { ok: false, error: 'oldpin' }; }
  if (!validPin_(d.newPin)) return { ok: false, error: 'badpin' };
  const sh = empSheet_(), h = hashPin_(emp.id, str_(d.newPin));
  sh.getRange(emp.row, 6, 1, 2).setValues([[h, 'ไม่']]);
  emp.hash = h;
  return { ok: true, token: makeToken_(emp) };
}

// ---------- พนักงาน: ยื่น / ดู / ยกเลิก ----------
function submit_(d) {
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  for (const k of ['cid', 'type', 'start', 'end', 'reason']) if (!d[k]) return { ok: false, error: 'missing ' + k };
  if (d.half && !d.mode) return { ok: false, error: 'outdated', message: 'แอปเป็นเวอร์ชันเก่า กรุณารีเฟรชหน้าแล้วลองใหม่' };
  const c = calcLeave_(d);
  if (c.error) return { ok: false, error: c.error, message: c.message };
  if (!(c.days > 0)) return { ok: false, error: 'invalid dates' };
  const dup = reqRows_().filter(o => o.r[R['clientId']] === d.cid)[0]; // กันส่งซ้ำ
  if (dup) return { ok: true, no: dup.r[R['เลขที่']], status: dup.r[R['สถานะ']] };
  const clash = conflict_(emp.id, String(d.start), String(d.end), c);
  if (clash) return { ok: false, error: 'overlap', message: 'มีใบลาในช่วงเวลานี้อยู่แล้ว (เลขที่ ' + clash + ')' };
  const retro = String(d.start) < todayStr_();
  if (retro && RETRO_REQUIRE_FILE && !(Array.isArray(d.files) && d.files.length)) return { ok: false, error: 'file', message: 'ลาย้อนหลังต้องแนบเอกสารประกอบอย่างน้อย 1 ไฟล์' };
  const chain = buildChain_(emp), sh = reqSheet_();
  const no = 'LV-' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyMMdd') + '-' + String(sh.getLastRow()).padStart(3, '0');
  const saved = saveFiles_(no, d.files);
  if (saved.error) return { ok: false, error: 'file', message: saved.error };
  const status = statusFor_(chain, 0);
  sh.appendRow([no, new Date(), d.cid, emp.id, emp.name, emp.dept, String(d.type), String(d.start), String(d.end), c.days,
    String(d.reason), String(d.phone || emp.phone || ''), status, 0, JSON.stringify(chain), 'ยังไม่ออก', '', '', JSON.stringify(saved.files),
    MODE_TH[c.mode], c.shift ? SHIFTS[c.shift].name : '', c.tStart, c.tEnd, c.hours, retro ? 'ย้อนหลัง' : '']);
  const info = { name: emp.name, empId: emp.id, type: String(d.type), start: String(d.start), end: String(d.end), days: c.days, reason: String(d.reason),
    when: whenTxt_({ mode: c.mode, shift: c.shift, tStart: c.tStart, tEnd: c.tEnd, hours: c.hours }), retro: retro };
  notifyStep_(chain[0], info, no);
  chain.slice(1).forEach(s => { if (s.role === 'MGR' || s.role === 'FM') notifyStep_(s, info, no, true); }); // แจ้งรับทราบล่วงหน้า
  return { ok: true, no: no, status: status };
}
function mine_(d) {
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  const rows = reqRows_(), items = [];
  for (let i = rows.length - 1; i >= 0 && items.length < 50; i--) {
    if (str_(rows[i].r[R['รหัสพนักงาน']]) === emp.id) items.push(item_(rows[i].r));
  }
  return { ok: true, items: items };
}
function cancel_(d) {
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  const o = reqRows_().filter(x => x.r[R['เลขที่']] === d.no)[0];
  if (!o || str_(o.r[R['รหัสพนักงาน']]) !== emp.id) return { ok: false, error: 'not found' };
  if (!isOpen_(o.r[R['สถานะ']])) return { ok: false, error: 'forbidden', message: 'ยกเลิกได้เฉพาะใบที่ยังไม่ออกใบลาและยังไม่ถูกพิจารณาจนจบ' };
  reqSheet_().getRange(o.row, R['สถานะ'] + 1).setValue(S_CANCEL);
  return { ok: true };
}

// ---------- ผู้อนุมัติ (หัวหน้า / MGR / FM) ----------
function inbox_(d) {
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  const items = waitingFor_(emp).map(o => item_(o.r));
  items.reverse();
  const upcoming = upcomingFor_(emp).map(o => item_(o.r)).reverse();
  return { ok: true, items: items, count: items.length, upcoming: upcoming };
}
function decide_(d) {
  const emp = verifyToken_(d.token);
  if (!emp) return { ok: false, error: 'auth' };
  if (d.decision !== 'ok' && d.decision !== 'no') return { ok: false, error: 'bad decision' };
  const o = waitingFor_(emp).filter(x => x.r[R['เลขที่']] === d.no)[0];
  if (!o) return { ok: false, error: 'forbidden', message: 'ไม่มีสิทธิ์ หรือใบลานี้ถูกดำเนินการไปแล้ว' };
  const r = o.r, sh = reqSheet_();
  const steps = parseJson_(r[R['เส้นทางอนุมัติ']], []), cur = Number(r[R['ขั้นปัจจุบัน']]) || 0;
  const s = steps[cur];
  s.by = emp.id; s.name = emp.name; s.decision = d.decision; s.at = nowIso_(); s.note = String(d.note || '').slice(0, 300);
  let status, next = cur;
  if (d.decision === 'no') status = S_NO;
  else { next = cur + 1; status = statusFor_(steps, next); }
  sh.getRange(o.row, R['สถานะ'] + 1, 1, 2).setValues([[status, next]]);
  sh.getRange(o.row, R['เส้นทางอนุมัติ'] + 1).setValue(JSON.stringify(steps));
  if (status !== S_NO) notifyStep_(steps[next], infoFromRow_(r), d.no);
  return { ok: true, status: status, inbox: waitingFor_(emp).length };
}

// ---------- HR (ต้องใส่รหัสผ่าน HR) ----------
function hr_(d) {
  if (d.passcode !== HR_PASSCODE) { Utilities.sleep(1500); return { ok: false, error: 'auth' }; }

  if (d.action === 'hrList') {
    const items = reqRows_().map(o => item_(o.r));
    items.reverse();
    return { ok: true, items: items };
  }

  if (d.action === 'hrIssue') { // HR กดว่าออกใบลาให้แล้ว / ยังไม่ออก
    const o = reqRows_().filter(x => x.r[R['เลขที่']] === d.no)[0];
    if (!o) return { ok: false, error: 'not found' };
    const r = o.r, sh = reqSheet_(), steps = parseJson_(r[R['เส้นทางอนุมัติ']], []), hrStep = steps[steps.length - 1];
    if (d.issued) {
      if (r[R['สถานะ']] !== S_HR) return { ok: false, error: 'forbidden', message: 'ออกใบลาได้เฉพาะใบที่ผู้อนุมัติอนุมัติครบทุกขั้นแล้ว' };
      hrStep.decision = 'ok'; hrStep.at = nowIso_(); hrStep.by = 'HR';
      sh.getRange(o.row, R['สถานะ'] + 1).setValue(S_DONE);
      sh.getRange(o.row, R['ออกใบลา'] + 1, 1, 2).setValues([['ออกแล้ว', new Date()]]);
    } else {
      if (r[R['สถานะ']] !== S_DONE) return { ok: false, error: 'forbidden', message: 'ใบนี้ยังไม่ได้ออกใบลา' };
      hrStep.decision = ''; hrStep.at = ''; delete hrStep.by;
      sh.getRange(o.row, R['สถานะ'] + 1).setValue(S_HR);
      sh.getRange(o.row, R['ออกใบลา'] + 1, 1, 2).setValues([['ยังไม่ออก', '']]);
    }
    sh.getRange(o.row, R['เส้นทางอนุมัติ'] + 1).setValue(JSON.stringify(steps));
    if (d.note !== undefined) sh.getRange(o.row, R['หมายเหตุ HR'] + 1).setValue(String(d.note).slice(0, 300));
    return { ok: true };
  }

  if (d.action === 'hrEmpList') {
    return { ok: true, employees: emps_().map(e => ({ id: e.id, name: e.name, dept: e.dept, phone: e.phone, email: e.email,
      active: e.active, hasPin: !!e.hash, mustChange: e.mustChange, sup: e.sup, mgr: e.mgr, fm: e.fm,
      startDate: e.start, vac: e.vac, hasPhoto: !!e.photo })) };
  }

  if (d.action === 'hrEmpSave') { // เพิ่ม/แก้พนักงาน (PIN ใส่เฉพาะตอนเพิ่มใหม่)
    const id = str_(d.empId);
    if (!id || !str_(d.name)) return { ok: false, error: 'missing empId/name' };
    if (id.indexOf('|') >= 0 || id.indexOf('.') >= 0) return { ok: false, error: 'bad empId' };
    const ap = [str_(d.sup), str_(d.mgr), str_(d.fm)];
    for (const a of ap) if (a && (a === id || !findEmp_(a))) return { ok: false, error: 'bad approver', message: 'ไม่พบรหัสผู้อนุมัติ ' + a + ' หรือเป็นรหัสของพนักงานคนนี้เอง' };
    const es = empSheet_(), emp = findEmp_(id), status = d.active === false ? E_OFF : E_ON;
    // ถ้าแอปไม่ได้ส่งวันเริ่มงาน/สิทธิ์พักร้อนมา ให้คงค่าเดิมไว้ (ไม่เขียนทับเป็นค่าว่าง)
    const vac = d.vac === undefined ? (emp ? emp.vac : '') : ((d.vac === '' || d.vac == null || isNaN(Number(d.vac))) ? '' : Number(d.vac));
    const start = d.startDate === undefined ? (emp ? emp.start : '') : str_(d.startDate);
    let photo = emp ? emp.photo : '';
    if (d.photo) {
      const ph = savePhoto_(id, d.photo, photo);
      if (ph.error) return { ok: false, error: 'photo', message: ph.error };
      photo = ph.id;
    } else if (d.removePhoto && photo) {
      try { DriveApp.getFileById(photo).setTrashed(true); } catch (e) {}
      photo = '';
    }
    if (emp) {
      es.getRange(emp.row, 2, 1, 4).setValues([[str_(d.name), str_(d.dept), str_(d.phone), status]]);
      es.getRange(emp.row, 8, 1, 4).setValues([[ap[0], ap[1], ap[2], str_(d.email)]]);
      es.getRange(emp.row, 12).setNumberFormat('@');
      es.getRange(emp.row, 12, 1, 3).setValues([[start, vac, photo]]);
      return { ok: true, created: false };
    }
    if (!validPin_(d.pin)) return { ok: false, error: 'badpin' };
    const row = es.getLastRow() + 1;
    es.getRange(row, 1, 1, 14).setNumberFormat('@');
    es.getRange(row, 1, 1, 14).setValues([[id, str_(d.name), str_(d.dept), str_(d.phone), status, hashPin_(id, str_(d.pin)), 'ใช่', ap[0], ap[1], ap[2], str_(d.email), start, vac, photo]]);
    return { ok: true, created: true };
  }

  if (d.action === 'hrEmpImport') { // rows: [[รหัส, ชื่อ, แผนก, รหัสหัวหน้า, รหัส MGR, รหัส FM], ...] + PIN เริ่มต้น
    if (!validPin_(d.pin)) return { ok: false, error: 'badpin' };
    if (!Array.isArray(d.rows)) return { ok: false, error: 'bad request' };
    const es = empSheet_(), have = {}, add = [], skipped = [];
    emps_().forEach(e => have[e.id] = 1);
    d.rows.forEach(r => {
      const id = str_(r[0]), name = str_(r[1]);
      if (!id || !name || id.indexOf('|') >= 0 || id.indexOf('.') >= 0 || have[id]) { if (id) skipped.push(id); return; }
      have[id] = 1;
      add.push([id, name, str_(r[2]), '', E_ON, hashPin_(id, str_(d.pin)), 'ใช่', str_(r[3]), str_(r[4]), str_(r[5]), '', '', '', '']);
    });
    if (add.length) {
      const start = es.getLastRow() + 1;
      es.getRange(start, 1, add.length, 14).setNumberFormat('@');
      es.getRange(start, 1, add.length, 14).setValues(add);
    }
    return { ok: true, added: add.length, skipped: skipped };
  }

  if (d.action === 'hrPinReset') {
    const emp = findEmp_(d.empId);
    if (!emp) return { ok: false, error: 'not found' };
    if (!validPin_(d.pin)) return { ok: false, error: 'badpin' };
    empSheet_().getRange(emp.row, 6, 1, 2).setValues([[hashPin_(emp.id, str_(d.pin)), 'ใช่']]);
    CacheService.getScriptCache().remove('fail:' + emp.id);
    return { ok: true };
  }

  // ----- แดชบอร์ดวันลาคงเหลือ -----
  if (d.action === 'hrBalList') { // ยอดคงเหลือของพนักงานทุกคนในปีที่เลือก
    const year = normYear_(d.year || thisYear_()), br = balRows_(year), us = usage_(year);
    return { ok: true, year: year, rows: emps_().map(e => ({ id: e.id, name: e.name, dept: e.dept, active: e.active,
      has: !!br[e.id], note: br[e.id] ? br[e.id].note : '', raw: br[e.id] ? { quota: br[e.id].quota, adj: br[e.id].adj } : null,
      bal: balanceFor_(e, br[e.id], us[e.id]) })) };
  }

  if (d.action === 'hrBalSave') { // กำหนดสิทธิ์ + ปรับยอดใช้ไปของพนักงาน 1 คน (ช่องสิทธิ์ว่าง = ยังไม่กำหนด)
    const id = str_(d.empId), year = normYear_(d.year);
    if (!findEmp_(id)) return { ok: false, error: 'not found' };
    if (!(year >= 2000 && year <= 2100)) return { ok: false, error: 'bad year' };
    const q = [d.sick, d.biz, d.vac].map(numOrNull_), a = [d.adjSick, d.adjBiz, d.adjVac].map(x => numOrNull_(x) || 0);
    if (q.some(x => x !== null && x < 0)) return { ok: false, error: 'bad quota', message: 'สิทธิ์วันลาต้องไม่ติดลบ' };
    const vals = [q[0] === null ? '' : q[0], q[1] === null ? '' : q[1], q[2] === null ? '' : q[2], a[0], a[1], a[2], str_(d.note).slice(0, 200)];
    const sh = balSheet_(), cur = balRows_(year)[id];
    if (cur) sh.getRange(cur.row, 3, 1, 7).setValues([vals]);
    else {
      const row = sh.getLastRow() + 1;
      sh.getRange(row, 1).setNumberFormat('@');
      sh.getRange(row, 1, 1, 9).setValues([[id, year].concat(vals)]);
    }
    return { ok: true };
  }

  if (d.action === 'hrBalSeed') { // ตั้งสิทธิ์เดียวกันให้พนักงานที่ใช้งานทุกคน (ข้ามคนที่มีแถวในปีนั้นแล้ว เว้นแต่ overwrite)
    const year = normYear_(d.year);
    if (!(year >= 2000 && year <= 2100)) return { ok: false, error: 'bad year' };
    const q = [d.sick, d.biz, d.vac].map(numOrNull_);
    if (q.every(x => x === null)) return { ok: false, error: 'missing', message: 'กรอกสิทธิ์อย่างน้อย 1 ประเภท' };
    if (q.some(x => x !== null && x < 0)) return { ok: false, error: 'bad quota', message: 'สิทธิ์วันลาต้องไม่ติดลบ' };
    const sh = balSheet_(), v = sh.getDataRange().getValues(), have = {};
    let updated = 0;
    for (let i = 1; i < v.length; i++) {
      const id = str_(v[i][0]);
      if (!id || normYear_(v[i][1]) !== year) continue;
      have[id] = 1;
      if (d.overwrite) { [0, 1, 2].forEach(k => { if (q[k] !== null) v[i][2 + k] = q[k]; }); updated++; }
    }
    if (updated) sh.getRange(1, 1, v.length, v[0].length).setValues(v);
    const add = [];
    emps_().filter(e => e.active && !have[e.id]).forEach(e => add.push([e.id, year, q[0] === null ? '' : q[0], q[1] === null ? '' : q[1], q[2] === null ? '' : q[2], 0, 0, 0, '']));
    if (add.length) {
      const row = sh.getLastRow() + 1;
      sh.getRange(row, 1, add.length, 1).setNumberFormat('@');
      sh.getRange(row, 1, add.length, 9).setValues(add);
    }
    return { ok: true, created: add.length, updated: updated };
  }
  return { ok: false, error: 'unknown action' };
}
