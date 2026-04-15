/**
 * بسم الله الرحمن الرحيم
 * supabase-client.js — طبقة API المشتركة لمنصة السرد
 * ضعها في نفس مجلد HTML أو استضفها على CDN خاصك
 *
 * الاستخدام:
 *   <script src="supabase-client.js"></script>
 *   <script>
 *     const db = new SardDB();
 *     await db.init();          // يجلب الجلسة المحفوظة
 *     const orgs = await db.getOrganizations();
 *   </script>
 */

// ===== اضبط هذين القيمتين من Supabase Dashboard → Settings → API =====
const SARD_SUPABASE_URL  = 'https://wqnnwovcteqkvoagsqmi.supabase.co';
const SARD_SUPABASE_ANON = 'sb_publishable_VcWBrkjfyRkmR36y2VcLcA_yJRNEFbn';
// ======================================================================

class SardDB {

  constructor() {
    this._url  = SARD_SUPABASE_URL.replace(/\/$/, '');
    this._anon = SARD_SUPABASE_ANON;
    this._token = null;       // JWT بعد تسجيل الدخول
    this._user  = null;
    this._orgId = null;
    this._role  = null;
  }

  // ─────────────────────────────────────────────
  // تهيئة: استرجاع الجلسة المحفوظة في localStorage
  // ─────────────────────────────────────────────
  async init() {
    const saved = this._loadSession();
    if (saved) {
      this._token = saved.access_token;
      this._user  = saved.user;
      // جلب صلاحيات المستخدم من جدول users
      try {
        const profile = await this._get('users', { id: `eq.${saved.user.id}`, select: 'org_id,role,full_name' });
        if (profile && profile[0]) {
          this._orgId = profile[0].org_id;
          this._role  = profile[0].role;
          this._user.full_name = profile[0].full_name;
        }
      } catch (e) { /* الجلسة منتهية */ this.logout(); }
    }
    return this._user;
  }

  // ─────────────────────────────────────────────
  // تسجيل دخول بالبريد وكلمة المرور
  // ─────────────────────────────────────────────
  async login(email, password) {
    const res = await this._fetch('POST', '/auth/v1/token?grant_type=password', { email, password });
    if (res.error) throw new Error(res.error.message || 'فشل تسجيل الدخول');
    this._token = res.access_token;
    this._user  = res.user;
    this._saveSession(res);
    await this.init();
    return this._user;
  }

  logout() {
    this._token = null;
    this._user  = null;
    this._orgId = null;
    this._role  = null;
    localStorage.removeItem('sard_session');
  }

  isLoggedIn()    { return !!this._token; }
  isSuperAdmin()  { return this._role === 'super_admin'; }
  getRole()       { return this._role; }
  getOrgId()      { return this._orgId; }
  getUser()       { return this._user; }

  // ─────────────────────────────────────────────
  // ① تسجيل مجمع جديد (صفحة register.html)
  // ─────────────────────────────────────────────
  async registerOrganization({ name, city, manager_name, email, phone, sessionName, studentsCount, importMethod, sheetsUrl, csvColMap }) {

    // ── جلب إعداد وضع القبول من Supabase (جدول platform_settings) ──
    let autoApprove = false;
    try {
      const setting = await this._get('platform_settings', 'key=eq.auto_approve&select=value');
      autoApprove = setting && setting[0] && setting[0].value === 'true';
    } catch(e) { /* إذا لم يوجد الجدول يبقى يدوياً */ }

    // أ) إنشاء سجل المجمع
    const orgPayload = {
      name,
      city,
      manager_name,
      email:  email.toLowerCase().trim(),
      phone,
      status: autoApprove ? 'active' : 'pending',
      plan:   'free',
      ...(autoApprove ? { approved_at: new Date().toISOString() } : {}),
    };
    const org = await this._insert('organizations', orgPayload);

    // ب) الدورة
    const session = await this._insert('sessions', {
      org_id: org.id,
      name:   sessionName,
      year:   new Date().getFullYear().toString(),
      status: autoApprove ? 'active' : 'draft',
    });

    // ج) طلب الاستيراد
    let importJob = null;
    if (importMethod === 'csv' || importMethod === 'sheets') {
      importJob = await this._insert('import_jobs', {
        org_id:      org.id,
        session_id:  session.id,
        source_type: importMethod === 'csv' ? 'csv_upload' : 'google_sheets',
        sheets_url:  importMethod === 'sheets' ? sheetsUrl : null,
        status:      'pending',
        ...(csvColMap ? { errors: [{ type: 'col_map', map: csvColMap }] } : {}),
      });
    }

    // د) في وضع القبول الفوري: أنشئ رابط دعوة فوراً
    let inviteToken = null;
    if (autoApprove) {
      inviteToken = this._genToken(28);
      await this._insert('invite_links', {
        org_id:     org.id,
        session_id: session.id,
        token:      inviteToken,
        role:       'supervisor',
        is_active:  true,
      });
    }

    return { org, session, importJob, autoApproved: autoApprove, inviteToken };
  }

  // ─────────────────────────────────────────────
  // ② رفع ملف CSV إلى Supabase Storage
  // ─────────────────────────────────────────────
  async uploadCSV(orgId, file) {
    const ext  = file.name.split('.').pop();
    const path = `${orgId}/${Date.now()}.${ext}`;

    const res = await fetch(
      `${this._url}/storage/v1/object/student-imports/${path}`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${this._token || this._anon}`, 'Content-Type': file.type },
        body:    file,
      }
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'فشل رفع الملف');
    }
    const publicUrl = `${this._url}/storage/v1/object/public/student-imports/${path}`;
    return publicUrl;
  }

  // ─────────────────────────────────────────────
  // ③ جلب كل المجمعات (لوحة الإدارة)
  // ─────────────────────────────────────────────
  async getOrganizations(statusFilter = null) {
    let query = 'select=id,name,city,manager_name,email,phone,status,plan,created_at,approved_at,notes';
    if (statusFilter) query += `&status=eq.${statusFilter}`;
    query += '&order=created_at.desc';
    return await this._get('organizations', query);
  }

  // جلب دورات مجمع معين
  async getOrgSessions(orgId) {
    return await this._get('sessions', `org_id=eq.${orgId}&order=created_at.desc`);
  }

  // ─────────────────────────────────────────────
  // ④ قبول مجمع
  // ─────────────────────────────────────────────
  async approveOrganization(orgId, adminNote = '') {
    // أ) تحديث الحالة
    await this._patch('organizations', orgId, {
      status:      'active',
      approved_at: new Date().toISOString(),
      approved_by: this._user?.id || null,
      notes:       adminNote || undefined,
    });

    // ب) تفعيل الدورة المرتبطة
    const sessions = await this.getOrgSessions(orgId);
    if (sessions && sessions[0]) {
      await this._patch('sessions', sessions[0].id, { status: 'active' });
    }

    // ج) إنشاء رابط دعوة افتراضي للمدير
    const inviteToken = this._genToken(28);
    const invite = await this._insert('invite_links', {
      org_id:     orgId,
      session_id: sessions[0]?.id,
      token:      inviteToken,
      role:       'supervisor',
      is_active:  true,
    });

    // د) إرسال بريد القبول عبر Edge Function
    await this._invokeFunction('send-org-email', {
      orgId,
      action:     'approved',
      inviteUrl:  `${window.location.origin}/join/${inviteToken}`,
      adminNote,
    });

    return { inviteToken, invite };
  }

  // ─────────────────────────────────────────────
  // ⑤ رفض مجمع
  // ─────────────────────────────────────────────
  async rejectOrganization(orgId, reason = '') {
    await this._patch('organizations', orgId, {
      status: 'rejected',
      notes:  reason,
    });
    await this._invokeFunction('send-org-email', {
      orgId,
      action: 'rejected',
      reason,
    });
  }

  // ─────────────────────────────────────────────
  // ⑥ إيقاف / إعادة تفعيل
  // ─────────────────────────────────────────────
  async suspendOrganization(orgId, reason = '') {
    await this._patch('organizations', orgId, { status: 'suspended', notes: reason });
    await this._invokeFunction('send-org-email', { orgId, action: 'suspended', reason });
  }

  async reactivateOrganization(orgId) {
    await this._patch('organizations', orgId, { status: 'active' });
    await this._invokeFunction('send-org-email', { orgId, action: 'reactivated' });
  }

  // ─────────────────────────────────────────────
  // ⑦ حفظ ملاحظات داخلية
  // ─────────────────────────────────────────────
  async saveOrgNotes(orgId, notes) {
    await this._patch('organizations', orgId, { notes });
  }

  // ─────────────────────────────────────────────
  // ⑧ إنشاء رابط دعوة جديد
  // ─────────────────────────────────────────────
  async createInviteLink(orgId, sessionId, role = 'teacher', halaqaName = null, expiresInDays = null) {
    const token = this._genToken(28);
    const payload = {
      org_id:      orgId,
      session_id:  sessionId,
      token,
      role,
      halaqa_name: halaqaName,
      is_active:   true,
      created_by:  this._user?.id || null,
    };
    if (expiresInDays) {
      const exp = new Date();
      exp.setDate(exp.getDate() + expiresInDays);
      payload.expires_at = exp.toISOString();
    }
    const invite = await this._insert('invite_links', payload);
    invite._url = `${window.location.origin}/join/${token}`;
    return invite;
  }

  // جلب روابط مجمع معين
  async getInviteLinks(orgId) {
    return await this._get('invite_links', `org_id=eq.${orgId}&order=created_at.desc`);
  }

  // إلغاء رابط
  async deactivateInvite(inviteId) {
    await this._patch('invite_links', inviteId, { is_active: false });
  }

  // ─────────────────────────────────────────────
  // ⑨ التحقق من رابط الدعوة (صفحة الانضمام)
  // ─────────────────────────────────────────────
  async validateInvite(token) {
    const res = await this._rpc('validate_invite', { p_token: token });
    if (!res || !res.valid) throw new Error('الرابط غير صالح أو منتهي الصلاحية');
    return res;
  }

  // ─────────────────────────────────────────────
  // ⑩ إحصائيات لوحة الإدارة
  // ─────────────────────────────────────────────
  async getAdminStats() {
    const orgs = await this.getOrganizations();
    const stats = {
      total:     orgs.length,
      pending:   orgs.filter(o => o.status === 'pending').length,
      active:    orgs.filter(o => o.status === 'active').length,
      rejected:  orgs.filter(o => o.status === 'rejected').length,
      suspended: orgs.filter(o => o.status === 'suspended').length,
    };
    return { orgs, stats };
  }

  // ─────────────────────────────────────────────
  // طلبات الاستيراد المعلقة
  // ─────────────────────────────────────────────
  async getPendingImports() {
    return await this._get('import_jobs', 'status=eq.pending&order=created_at.desc&select=*,organizations(name)');
  }

  // ─────────────────────────────────────────────
  // HTTP PRIMITIVES
  // ─────────────────────────────────────────────
  async _upsert(table, body) {
    const res = await this._fetch('POST', `/rest/v1/${table}`, body, {
      'Prefer':      'return=minimal,resolution=merge-duplicates',
      'on-conflict': 'key',
    });
    return res;
  }

  async _get(table, query = '') {
    const sep = query ? '?' : '';
    const res = await this._fetch('GET', `/rest/v1/${table}${sep}${query}`);
    if (res && res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return res;
  }

  async _insert(table, body) {
    const res = await this._fetch('POST', `/rest/v1/${table}`, body, {
      'Prefer': 'return=representation',
    });
    if (!res || res.error) throw new Error((res && res.error?.message) || 'خطأ في الإدراج');
    return Array.isArray(res) ? res[0] : res;
  }

  async _patch(table, id, body) {
    const res = await this._fetch('PATCH', `/rest/v1/${table}?id=eq.${id}`, body, {
      'Prefer': 'return=minimal',
    });
    return res;
  }

  async _rpc(fn, params) {
    const res = await this._fetch('POST', `/rest/v1/rpc/${fn}`, params);
    if (res && res.error) throw new Error(res.error.message);
    return res;
  }

  async _invokeFunction(name, body) {
    // استدعاء Edge Function
    const res = await this._fetch('POST', `/functions/v1/${name}`, body);
    if (res && res.error) {
      // الفشل في إرسال البريد لا يوقف العملية — يُسجَّل فقط
      console.warn(`Edge Function [${name}] failed:`, res.error);
    }
    return res;
  }

  async _fetch(method, path, body = null, extraHeaders = {}) {
    const headers = {
      'Content-Type':  'application/json',
      'apikey':        this._anon,
      'Authorization': `Bearer ${this._token || this._anon}`,
      ...extraHeaders,
    };

    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const res = await fetch(`${this._url}${path}`, opts);

    // 204 No Content
    if (res.status === 204) return null;

    const text = await res.text();
    if (!text) return null;

    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error('استجابة غير صالحة من الخادم'); }

    if (!res.ok && json.error) throw new Error(json.error.message || json.message || `HTTP ${res.status}`);
    return json;
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────
  _genToken(len = 24) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let t = '';
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    arr.forEach(b => (t += chars[b % chars.length]));
    return t;
  }

  _saveSession(res) {
    const data = { access_token: res.access_token, user: res.user };
    localStorage.setItem('sard_session', JSON.stringify(data));
  }

  _loadSession() {
    try { return JSON.parse(localStorage.getItem('sard_session') || 'null'); }
    catch { return null; }
  }
}

// تصدير Global (للاستخدام مباشرة في HTML بدون bundler)
window.SardDB = SardDB;
