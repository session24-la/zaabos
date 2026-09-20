'use strict';
/* ZaabOS shared i18n engine — used by every page (admin, customer order,
   track, kitchen). One dictionary, one language switcher pattern, so all
   four pages behave identically and stay in sync automatically.

   Usage per page:
     - Include this file BEFORE the page's own script.
     - Static text: add data-i18n="key" (textContent), data-i18n-ph="key"
       (placeholder), or data-i18n-title="key" (title attr) to elements,
       then call applyI18n() once on load and again after setLang().
     - Dynamic/templated text inside JS-built HTML: call t('key') or
       t('key', {name: value}) for strings with a {name} placeholder.
     - Call initLangSwitcher('#langSelect') once; it fills the <select>,
       restores the saved language, and re-renders on change by calling
       any onLangChange callbacks registered with onLangChange(fn).
*/

const LANGS = [
  { code: 'lo', label: '🇱🇦 ລາວ', locale: 'lo-LA' },
  { code: 'th', label: '🇹🇭 ไทย', locale: 'th-TH' },
  { code: 'zh', label: '🇨🇳 中文', locale: 'zh-CN' },
  { code: 'en', label: '🇬🇧 English', locale: 'en-US' },
];
const LANG_STORAGE_KEY = 'zaabos_lang';

const I18N = {
  // ---------- common ----------
  btn_save: { th: 'บันทึก', lo: 'ບັນທຶກ', zh: '保存', en: 'Save' },
  login_username: { th: 'ชื่อผู้ใช้', lo: 'ຊື່ຜູ້ໃຊ້', zh: '用户名', en: 'Username' },
  login_password: { th: 'รหัสผ่าน', lo: 'ລະຫັດຜ່ານ', zh: '密码', en: 'Password' },
  login_submit: { th: 'เข้าสู่ระบบ', lo: 'ເຂົ້າສູ່ລະບົບ', zh: '登录', en: 'Log in' },
  err_connect_failed: { th: 'เชื่อมต่อไม่ได้ กรุณาลองใหม่อีกครั้ง', lo: 'ເຊື່ອມຕໍ່ບໍ່ໄດ້ ກະລຸນາລອງໃໝ່ອີກຄັ້ງ', zh: '连接失败，请重试', en: 'Could not connect. Please try again.' },
  err_fill_all: { th: 'กรุณากรอกข้อมูลให้ครบ', lo: 'ກະລຸນາປ້ອນຂໍ້ມູນໃຫ້ຄົບ', zh: '请填写完整信息', en: 'Please fill in all fields.' },
  err_price_invalid: { th: 'ราคาไม่ถูกต้อง', lo: 'ລາຄາບໍ່ຖືກຕ້ອງ', zh: '价格无效', en: 'Invalid price.' },
  label_notes: { th: 'หมายเหตุ', lo: 'ໝາຍເຫດ', zh: '备注', en: 'Notes' },
  label_table: { th: 'โต๊ะ', lo: 'ໂຕະ', zh: '桌号', en: 'Table' },
  label_customer_name: { th: 'ชื่อลูกค้า', lo: 'ຊື່ລູກຄ້າ', zh: '顾客姓名', en: 'Customer name' },
  label_phone: { th: 'เบอร์โทร', lo: 'ເບີໂທ', zh: '电话号码', en: 'Phone number' },
  label_delivery_address: { th: 'ที่อยู่จัดส่ง', lo: 'ທີ່ຢູ່ຈັດສົ່ງ', zh: '送货地址', en: 'Delivery address' },
  label_total: { th: 'รวมทั้งหมด', lo: 'ລວມທັງໝົດ', zh: '总计', en: 'Total' },
  label_total_short: { th: 'รวม', lo: 'ລວມ', zh: '合计', en: 'Total' },
  btn_add_to_cart: { th: 'เพิ่มลงตะกร้า', lo: 'ເພີ່ມໃສ່ກະຕ່າ', zh: '加入购物车', en: 'Add to cart' },
  cat_all: { th: 'ทั้งหมด', lo: 'ທັງໝົດ', zh: '全部', en: 'All' },
  err_please_login: { th: 'กรุณาเข้าสู่ระบบ', lo: 'ກະລຸນາເຂົ້າສູ່ລະບົບ', zh: '请先登录', en: 'Please log in' },
  err_generic: { th: 'เกิดข้อผิดพลาด', lo: 'ເກີດຂໍ້ຜິດພາດ', zh: '发生错误', en: 'Something went wrong' },
  err_login_failed: { th: 'เข้าสู่ระบบไม่สำเร็จ', lo: 'ເຂົ້າສູ່ລະບົບບໍ່ສຳເລັດ', zh: '登录失败', en: 'Login failed' },

  // order type (shared: admin take-order, customer order page, kitchen board)
  order_type_dine_in: { th: '🍽️ ทานที่ร้าน', lo: '🍽️ ກິນຢູ່ຮ້ານ', zh: '🍽️ 堂食', en: '🍽️ Dine in' },
  order_type_takeaway: { th: '🥡 กลับบ้าน', lo: '🥡 ເອົາກັບບ້ານ', zh: '🥡 打包', en: '🥡 Takeaway' },
  order_type_delivery: { th: '🛵 เดลิเวอรี่', lo: '🛵 ສົ່ງເຖິງບ້ານ', zh: '🛵 外送', en: '🛵 Delivery' },

  // order status (shared: admin order list, track page, kitchen board)
  status_all: { th: 'ทุกสถานะ', lo: 'ທຸກສະຖານະ', zh: '所有状态', en: 'All statuses' },
  status_received: { th: 'รับออเดอร์แล้ว', lo: 'ຮັບອໍເດີແລ້ວ', zh: '已接单', en: 'Received' },
  status_preparing: { th: 'กำลังทำ', lo: 'ກຳລັງເຮັດ', zh: '制作中', en: 'Preparing' },
  status_ready: { th: 'พร้อมเสิร์ฟ', lo: 'ພ້ອມເສີບ', zh: '可以上菜', en: 'Ready to serve' },
  status_served: { th: 'เสิร์ฟแล้ว', lo: 'ເສີບແລ້ວ', zh: '已上菜', en: 'Served' },
  status_completed: { th: 'เสร็จสิ้น', lo: 'ສຳເລັດ', zh: '已完成', en: 'Completed' },
  status_cancelled: { th: 'ยกเลิก', lo: 'ຍົກເລີກ', zh: '已取消', en: 'Cancelled' },
  payment_paid: { th: 'ชำระแล้ว', lo: 'ຈ່າຍແລ້ວ', zh: '已付款', en: 'Paid' },
  payment_unpaid: { th: 'ยังไม่ชำระ', lo: 'ຍັງບໍ່ຈ່າຍ', zh: '未付款', en: 'Unpaid' },

  // ---------- admin/staff SPA (index.html + app.js) ----------
  admin_login_sub: { th: 'ระบบจัดการร้านอาหาร — เข้าสู่ระบบเพื่อจัดการร้านของคุณ', lo: 'ລະບົບຈັດການຮ້ານອາຫານ — ເຂົ້າສູ່ລະບົບເພື່ອຈັດການຮ້ານຂອງທ່ານ', zh: '餐厅管理系统 — 登录以管理您的店铺', en: 'Restaurant management system — log in to manage your shop' },
  menu_change_password: { th: '🔒 เปลี่ยนรหัสผ่าน', lo: '🔒 ປ່ຽນລະຫັດຜ່ານ', zh: '🔒 修改密码', en: '🔒 Change password' },
  menu_change_username: { th: '👤 เปลี่ยนชื่อผู้ใช้', lo: '👤 ປ່ຽນຊື່ຜູ້ໃຊ້', zh: '👤 修改用户名', en: '👤 Change username' },
  menu_logout: { th: '🚪 ออกจากระบบ', lo: '🚪 ອອກຈາກລະບົບ', zh: '🚪 退出登录', en: '🚪 Log out' },
  scope_branch_label: { th: 'สาขา', lo: 'ສາຂາ', zh: '分店', en: 'Branch' },
  btn_qr_all_tables: { th: '📱 QR โต๊ะทั้งหมด', lo: '📱 QR ໂຕະທັງໝົດ', zh: '📱 全部桌台二维码', en: '📱 All table QRs' },
  tenant_switcher_all: { th: 'ทุกร้าน', lo: 'ທຸກຮ້ານ', zh: '所有商户', en: 'All shops' },
  btn_mark_paid: { th: '💰 บันทึกว่าชำระแล้ว', lo: '💰 ບັນທຶກວ່າຈ່າຍແລ້ວ', zh: '💰 标记为已付款', en: '💰 Mark as paid' },
  btn_unmark_paid: { th: '↩️ ยกเลิกการชำระ', lo: '↩️ ຍົກເລີກການຈ່າຍ', zh: '↩️ 取消付款标记', en: '↩️ Undo payment' },
  hint_no_options: { th: 'ไม่มีตัวเลือกเพิ่มเติมสำหรับเมนูนี้', lo: 'ບໍ່ມີຕົວເລືອກເພີ່ມເຕີມສຳລັບເມນູນີ້', zh: '此菜品没有附加选项', en: 'No extra options for this item' },

  role_super_admin: { th: 'ผู้ดูแลระบบ', lo: 'ຜູ້ດູແລລະບົບ', zh: '系统管理员', en: 'Super admin' },
  role_owner: { th: 'เจ้าของร้าน', lo: 'ເຈົ້າຂອງຮ້ານ', zh: '店主', en: 'Owner' },
  role_manager: { th: 'ผู้จัดการ', lo: 'ຜູ້ຈັດການ', zh: '经理', en: 'Manager' },
  role_staff: { th: 'พนักงาน', lo: 'ພະນັກງານ', zh: '员工', en: 'Staff' },

  tab_orders: { th: 'ออเดอร์', lo: 'ອໍເດີ', zh: '订单', en: 'Orders' },
  tab_tables: { th: 'โต๊ะ & QR', lo: 'ໂຕະ & QR', zh: '桌台与二维码', en: 'Tables & QR' },
  tab_menu: { th: 'เมนู', lo: 'ເມນູ', zh: '菜单', en: 'Menu' },
  tab_branches: { th: 'สาขา', lo: 'ສາຂາ', zh: '分店', en: 'Branches' },
  tab_users: { th: 'ผู้ใช้งาน', lo: 'ຜູ້ໃຊ້', zh: '用户', en: 'Users' },
  tab_tenants: { th: 'ร้านค้า', lo: 'ຮ້ານຄ້າ', zh: '商户', en: 'Shops' },

  orders_queue_title: { th: 'คิวออเดอร์', lo: 'ຄິວອໍເດີ', zh: '订单队列', en: 'Order queue' },
  btn_take_order: { th: '➕ รับออเดอร์ลูกค้า', lo: '➕ ຮັບອໍເດີລູກຄ້າ', zh: '➕ 帮客人下单', en: '➕ Take customer order' },
  btn_refresh: { th: '🔄 รีเฟรช', lo: '🔄 ໂຫຼດໃໝ່', zh: '🔄 刷新', en: '🔄 Refresh' },
  empty_orders: { th: 'ยังไม่มีออเดอร์', lo: 'ຍັງບໍ່ມີອໍເດີ', zh: '暂无订单', en: 'No orders yet' },

  tables_title: { th: 'โต๊ะในสาขานี้', lo: 'ໂຕະໃນສາຂານີ້', zh: '本分店的桌台', en: 'Tables in this branch' },
  btn_bulk_add_tables: { th: '🔢 สร้างหลายโต๊ะ', lo: '🔢 ສ້າງຫຼາຍໂຕະ', zh: '🔢 批量创建桌台', en: '🔢 Bulk-create tables' },
  btn_add_table: { th: '➕ เพิ่มโต๊ะ', lo: '➕ ເພີ່ມໂຕະ', zh: '➕ 添加桌台', en: '➕ Add table' },
  empty_tables: { th: 'ยังไม่มีโต๊ะในสาขานี้', lo: 'ຍັງບໍ່ມີໂຕະໃນສາຂານີ້', zh: '本分店暂无桌台', en: 'No tables in this branch yet' },

  categories_title: { th: 'หมวดหมู่เมนู', lo: 'ໝວດໝູ່ເມນູ', zh: '菜单分类', en: 'Menu categories' },
  btn_add_category: { th: '➕ เพิ่มหมวดหมู่', lo: '➕ ເພີ່ມໝວດໝູ່', zh: '➕ 添加分类', en: '➕ Add category' },
  empty_categories: { th: 'ยังไม่มีหมวดหมู่เมนู', lo: 'ຍັງບໍ່ມີໝວດໝູ່ເມນູ', zh: '暂无菜单分类', en: 'No menu categories yet' },
  menu_items_title: { th: 'รายการเมนู', lo: 'ລາຍການເມນູ', zh: '菜品列表', en: 'Menu items' },
  btn_add_menu_item: { th: '➕ เพิ่มเมนู', lo: '➕ ເພີ່ມເມນູ', zh: '➕ 添加菜品', en: '➕ Add menu item' },
  empty_menu_items: { th: 'ยังไม่มีเมนูในสาขานี้', lo: 'ຍັງບໍ່ມີເມນູໃນສາຂານີ້', zh: '本分店暂无菜品', en: 'No menu items in this branch yet' },
  btn_edit: { th: '✏️ แก้ไข', lo: '✏️ ແກ້ໄຂ', zh: '✏️ 编辑', en: '✏️ Edit' },
  btn_mark_sold_out: { th: '🚫 แจ้งของหมด', lo: '🚫 ແຈ້ງໝົດ', zh: '🚫 标记售罄', en: '🚫 Mark sold out' },
  btn_mark_available: { th: '✅ กลับมามีของ', lo: '✅ ກັບມາມີແລ້ວ', zh: '✅ 恢复供应', en: '✅ Back in stock' },
  badge_sold_out: { th: 'หมด', lo: 'ໝົດ', zh: '售罄', en: 'Sold out' },
  label_options_prefix: { th: 'ตัวเลือก', lo: 'ຕົວເລືອກ', zh: '选项', en: 'Options' },

  branches_title: { th: 'สาขาทั้งหมด', lo: 'ສາຂາທັງໝົດ', zh: '所有分店', en: 'All branches' },
  btn_add_branch: { th: '➕ เพิ่มสาขา', lo: '➕ ເພີ່ມສາຂາ', zh: '➕ 添加分店', en: '➕ Add branch' },
  empty_branches: { th: 'ยังไม่มีสาขา', lo: 'ຍັງບໍ່ມີສາຂາ', zh: '暂无分店', en: 'No branches yet' },
  label_branch_code_prefix: { th: 'รหัสสาขา', lo: 'ລະຫັດສາຂາ', zh: '分店编号', en: 'Branch ID' },

  users_title: { th: 'ผู้ใช้งานในร้าน', lo: 'ຜູ້ໃຊ້ໃນຮ້ານ', zh: '店内用户', en: 'Users in this shop' },
  btn_add_user: { th: '➕ เพิ่มผู้ใช้งาน', lo: '➕ ເພີ່ມຜູ້ໃຊ້', zh: '➕ 添加用户', en: '➕ Add user' },
  empty_users: { th: 'ยังไม่มีผู้ใช้งาน', lo: 'ຍັງບໍ່ມີຜູ້ໃຊ້', zh: '暂无用户', en: 'No users yet' },
  label_inactive_suffix: { th: '(ปิดใช้งาน)', lo: '(ປິດໃຊ້ງານ)', zh: '（已停用）', en: '(inactive)' },

  tenants_title: { th: 'ร้านค้าทั้งหมด (ผู้ดูแลระบบ)', lo: 'ຮ້ານຄ້າທັງໝົດ (ຜູ້ດູແລລະບົບ)', zh: '所有商户（系统管理员）', en: 'All shops (super admin)' },
  btn_add_tenant: { th: '➕ เพิ่มร้านค้าใหม่', lo: '➕ ເພີ່ມຮ້ານໃໝ່', zh: '➕ 新增商户', en: '➕ Add new shop' },
  empty_tenants: { th: 'ยังไม่มีร้านค้า', lo: 'ຍັງບໍ່ມີຮ້ານ', zh: '暂无商户', en: 'No shops yet' },
  tenant_active: { th: 'ใช้งานอยู่', lo: 'ກຳລັງໃຊ້ງານ', zh: '使用中', en: 'Active' },
  tenant_suspended: { th: 'ถูกระงับ', lo: 'ຖືກລະງັບ', zh: '已停用', en: 'Suspended' },

  modal_new_password_title: { th: 'ตั้งรหัสผ่านใหม่', lo: 'ຕັ້ງລະຫັດຜ່ານໃໝ່', zh: '设置新密码', en: 'Set a new password' },
  pw_forced_hint: { th: 'เพื่อความปลอดภัย กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งานต่อ', lo: 'ເພື່ອຄວາມປອດໄພ ກະລຸນາຕັ້ງລະຫັດຜ່ານໃໝ່ກ່ອນໃຊ້ງານຕໍ່', zh: '出于安全考虑，请先设置新密码再继续使用', en: 'For security, please set a new password before continuing' },
  label_current_password: { th: 'รหัสผ่านปัจจุบัน', lo: 'ລະຫັດຜ່ານປັດຈຸບັນ', zh: '当前密码', en: 'Current password' },
  label_new_password: { th: 'รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)', lo: 'ລະຫັດຜ່ານໃໝ່ (ຢ່າງໜ້ອຍ 6 ຕົວ)', zh: '新密码（至少6位）', en: 'New password (min. 6 characters)' },

  modal_change_username_title: { th: 'เปลี่ยนชื่อผู้ใช้', lo: 'ປ່ຽນຊື່ຜູ້ໃຊ້', zh: '修改用户名', en: 'Change username' },
  label_current_username: { th: 'ชื่อผู้ใช้ปัจจุบัน', lo: 'ຊື່ຜູ້ໃຊ້ປັດຈຸບັນ', zh: '当前用户名', en: 'Current username' },
  label_new_username: { th: 'ชื่อผู้ใช้ใหม่', lo: 'ຊື່ຜູ້ໃຊ້ໃໝ່', zh: '新用户名', en: 'New username' },
  label_password_confirm: { th: 'รหัสผ่าน (เพื่อยืนยันตัวตน)', lo: 'ລະຫັດຜ່ານ (ເພື່ອຢືນຢັນຕົວຕົນ)', zh: '密码（用于身份验证）', en: 'Password (to confirm identity)' },

  modal_add_branch_title: { th: 'เพิ่มสาขา', lo: 'ເພີ່ມສາຂາ', zh: '添加分店', en: 'Add branch' },
  modal_edit_branch_title: { th: 'แก้ไขสาขา', lo: 'ແກ້ໄຂສາຂາ', zh: '编辑分店', en: 'Edit branch' },
  label_icon: { th: 'ไอคอน', lo: 'ໄອຄອນ', zh: '图标', en: 'Icon' },
  label_branch_name: { th: 'ชื่อสาขา', lo: 'ຊື່ສາຂາ', zh: '分店名称', en: 'Branch name' },
  placeholder_branch_name: { th: 'เช่น สาขาหลัก', lo: 'ເຊັ່ນ: ສາຂາຫຼັກ', zh: '例如：总店', en: 'e.g. Main branch' },

  modal_add_table_title: { th: 'เพิ่มโต๊ะ', lo: 'ເພີ່ມໂຕະ', zh: '添加桌台', en: 'Add table' },
  modal_edit_table_title: { th: 'แก้ไขโต๊ะ', lo: 'ແກ້ໄຂໂຕະ', zh: '编辑桌台', en: 'Edit table' },
  label_table_name: { th: 'ชื่อโต๊ะ', lo: 'ຊື່ໂຕະ', zh: '桌台名称', en: 'Table name' },
  placeholder_table_name: { th: 'เช่น โต๊ะ 1', lo: 'ເຊັ່ນ: ໂຕະ 1', zh: '例如：1号桌', en: 'e.g. Table 1' },

  modal_bulk_tables_title: { th: 'สร้างหลายโต๊ะพร้อมกัน', lo: 'ສ້າງຫຼາຍໂຕະພ້ອມກັນ', zh: '批量创建桌台', en: 'Create multiple tables at once' },
  bulk_tables_hint: { th: 'ระบบจะสร้างโต๊ะให้อัตโนมัติ พร้อม QR โค้ดเฉพาะของแต่ละโต๊ะ', lo: 'ລະບົບຈະສ້າງໂຕະໃຫ້ອັດຕະໂນມັດ ພ້ອມ QR ໂຄດສະເພາະຂອງແຕ່ລະໂຕະ', zh: '系统将自动创建桌台，并为每张桌台生成专属二维码', en: 'The system will auto-create tables, each with its own unique QR code' },
  label_table_count: { th: 'จำนวนโต๊ะที่ต้องการสร้าง', lo: 'ຈຳນວນໂຕະທີ່ຕ້ອງການສ້າງ', zh: '要创建的桌台数量', en: 'Number of tables to create' },
  btn_create_tables: { th: 'สร้างโต๊ะ', lo: 'ສ້າງໂຕະ', zh: '创建桌台', en: 'Create tables' },

  qr_modal_title_all: { th: 'QR โต๊ะทั้งหมด', lo: 'QR ໂຕະທັງໝົດ', zh: '全部桌台二维码', en: 'All table QRs' },
  qr_table_prefix: { th: 'QR โต๊ะ', lo: 'QR ໂຕະ', zh: '桌台二维码', en: 'Table QR' },
  btn_copy_link: { th: '📋 คัดลอกลิงก์', lo: '📋 ຄັດລອກລິ້ງ', zh: '📋 复制链接', en: '📋 Copy link' },
  btn_open_order_page: { th: '🔗 เปิดหน้าสั่งอาหาร', lo: '🔗 ເປີດໜ້າສັ່ງອາຫານ', zh: '🔗 打开点餐页面', en: '🔗 Open ordering page' },
  toast_link_copied: { th: 'คัดลอกลิงก์แล้ว', lo: 'ຄັດລອກລິ້ງແລ້ວ', zh: '链接已复制', en: 'Link copied' },

  modal_add_category_title: { th: 'เพิ่มหมวดหมู่', lo: 'ເພີ່ມໝວດໝູ່', zh: '添加分类', en: 'Add category' },
  modal_edit_category_title: { th: 'แก้ไขหมวดหมู่', lo: 'ແກ້ໄຂໝວດໝູ່', zh: '编辑分类', en: 'Edit category' },
  label_category_name: { th: 'ชื่อหมวดหมู่', lo: 'ຊື່ໝວດໝູ່', zh: '分类名称', en: 'Category name' },
  placeholder_category_name: { th: 'เช่น อาหารจานหลัก', lo: 'ເຊັ່ນ: ອາຫານຈານຫຼັກ', zh: '例如：主菜', en: 'e.g. Main dishes' },

  modal_add_menu_item_title: { th: 'เพิ่มเมนู', lo: 'ເພີ່ມເມນູ', zh: '添加菜品', en: 'Add menu item' },
  modal_edit_menu_item_title: { th: 'แก้ไขเมนู', lo: 'ແກ້ໄຂເມນູ', zh: '编辑菜品', en: 'Edit menu item' },
  label_menu_item_name: { th: 'ชื่อเมนู', lo: 'ຊື່ເມນູ', zh: '菜品名称', en: 'Item name' },
  placeholder_menu_item_name: { th: 'เช่น ผัดไทย', lo: 'ເຊັ່ນ: ຜັດໄທ', zh: '例如：泰式炒河粉', en: 'e.g. Pad Thai' },
  label_description: { th: 'รายละเอียด', lo: 'ລາຍລະອຽດ', zh: '描述', en: 'Description' },
  placeholder_description: { th: 'คำอธิบายสั้น ๆ (ถ้ามี)', lo: 'ຄຳອະທິບາຍສັ້ນໆ (ຖ້າມີ)', zh: '简短描述（可选）', en: 'A short description (optional)' },
  label_category: { th: 'หมวดหมู่', lo: 'ໝວດໝູ່', zh: '分类', en: 'Category' },
  option_no_category: { th: '(ไม่มีหมวดหมู่)', lo: '(ບໍ່ມີໝວດໝູ່)', zh: '（无分类）', en: '(No category)' },
  label_base_price: { th: 'ราคาพื้นฐาน', lo: 'ລາຄາພື້ນຖານ', zh: '基础价格', en: 'Base price' },
  label_sold_out_temp: { th: 'หมดชั่วคราว (ของหมด)', lo: 'ໝົດຊົ່ວຄາວ (ຂອງໝົດ)', zh: '暂时缺货（售罄）', en: 'Temporarily sold out' },
  label_option_groups_title: { th: 'ตัวเลือกเพิ่มเติม (เช่น ขนาด, ความเผ็ด)', lo: 'ຕົວເລືອກເພີ່ມເຕີມ (ເຊັ່ນ: ຂະໜາດ, ລະດັບເຜັດ)', zh: '附加选项（如份量、辣度）', en: 'Extra options (e.g. size, spice level)' },
  label_item_image: { th: 'รูปภาพเมนู', lo: 'ຮູບເມນູ', zh: '菜品图片', en: 'Item photo' },
  btn_choose_image: { th: '📷 เลือกรูปภาพ', lo: '📷 ເລືອກຮູບ', zh: '📷 选择图片', en: '📷 Choose photo' },
  btn_change_image: { th: '📷 เปลี่ยนรูปภาพ', lo: '📷 ປ່ຽນຮູບ', zh: '📷 更换图片', en: '📷 Change photo' },
  btn_remove_image: { th: '🗑️ ลบรูปภาพ', lo: '🗑️ ລຶບຮູບ', zh: '🗑️ 删除图片', en: '🗑️ Remove photo' },
  err_image_too_large: { th: 'ไฟล์รูปภาพมีขนาดใหญ่เกินไป', lo: 'ໄຟລ໌ຮູບໃຫຍ່ເກີນໄປ', zh: '图片文件过大', en: 'Image file is too large' },
  err_image_invalid_type: { th: 'กรุณาเลือกไฟล์รูปภาพ (JPG, PNG)', lo: 'ກະລຸນາເລືອກໄຟລ໌ຮູບພາບ (JPG, PNG)', zh: '请选择图片文件（JPG、PNG）', en: 'Please choose an image file (JPG, PNG)' },
  btn_add_option_group: { th: '➕ เพิ่มกลุ่มตัวเลือก', lo: '➕ ເພີ່ມກຸ່ມຕົວເລືອກ', zh: '➕ 添加选项组', en: '➕ Add option group' },
  placeholder_group_name: { th: 'ชื่อกลุ่ม เช่น ขนาด', lo: 'ຊື່ກຸ່ມ ເຊັ່ນ: ຂະໜາດ', zh: '组名，例如：份量', en: 'Group name, e.g. Size' },
  label_required_choice: { th: 'บังคับเลือก', lo: 'ບັງຄັບເລືອກ', zh: '必选', en: 'Required' },
  placeholder_option_name: { th: 'ชื่อตัวเลือก', lo: 'ຊື່ຕົວເລືອກ', zh: '选项名称', en: 'Option name' },
  placeholder_option_price: { th: '+ราคา', lo: '+ລາຄາ', zh: '+价格', en: '+price' },
  btn_add_option: { th: '➕ เพิ่มตัวเลือก', lo: '➕ ເພີ່ມຕົວເລືອກ', zh: '➕ 添加选项', en: '➕ Add option' },

  modal_add_user_title: { th: 'เพิ่มผู้ใช้งาน', lo: 'ເພີ່ມຜູ້ໃຊ້', zh: '添加用户', en: 'Add user' },
  modal_edit_user_title: { th: 'แก้ไขผู้ใช้งาน', lo: 'ແກ້ໄຂຜູ້ໃຊ້', zh: '编辑用户', en: 'Edit user' },
  label_username_login: { th: 'ชื่อผู้ใช้ (login)', lo: 'ຊື່ຜູ້ໃຊ້ (login)', zh: '用户名（登录用）', en: 'Username (login)' },
  label_display_name: { th: 'ชื่อที่แสดง', lo: 'ຊື່ທີ່ສະແດງ', zh: '显示名称', en: 'Display name' },
  label_role: { th: 'สิทธิ์การใช้งาน', lo: 'ສິດການໃຊ້ງານ', zh: '权限角色', en: 'Role' },
  label_password: { th: 'รหัสผ่าน', lo: 'ລະຫັດຜ່ານ', zh: '密码', en: 'Password' },
  label_password_new_optional: { th: 'ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)', lo: 'ຕັ້ງລະຫັດຜ່ານໃໝ່ (ປະໄວ້ຫວ່າງຖ້າບໍ່ປ່ຽນ)', zh: '设置新密码（留空则不修改）', en: 'Set new password (leave blank to keep)' },
  label_active_account: { th: 'เปิดใช้งานบัญชีนี้', lo: 'ເປີດໃຊ້ງານບັນຊີນີ້', zh: '启用此账户', en: 'Enable this account' },

  modal_add_tenant_title: { th: 'เพิ่มร้านค้าใหม่', lo: 'ເພີ່ມຮ້ານໃໝ່', zh: '新增商户', en: 'Add new shop' },
  label_shop_name: { th: 'ชื่อร้าน', lo: 'ຊື່ຮ້ານ', zh: '店铺名称', en: 'Shop name' },
  label_owner_account_title: { th: 'บัญชีเจ้าของร้าน', lo: 'ບັນຊີເຈົ້າຂອງຮ້ານ', zh: '店主账户', en: 'Owner account' },
  btn_create_shop: { th: 'สร้างร้านค้า', lo: 'ສ້າງຮ້ານ', zh: '创建商户', en: 'Create shop' },

  modal_take_order_title: { th: 'รับออเดอร์ลูกค้า', lo: 'ຮັບອໍເດີລູກຄ້າ', zh: '为顾客下单', en: 'Take customer order' },
  label_choose_menu: { th: 'เลือกเมนู', lo: 'ເລືອກເມນູ', zh: '选择菜品', en: 'Choose items' },
  label_cart: { th: 'ตะกร้า', lo: 'ກະຕ່າ', zh: '购物车', en: 'Cart' },
  btn_confirm_order: { th: '✅ ยืนยันออเดอร์', lo: '✅ ຢືນຢັນອໍເດີ', zh: '✅ 确认下单', en: '✅ Confirm order' },
  empty_cart_staff: { th: 'ยังไม่มีรายการในตะกร้า', lo: 'ຍັງບໍ່ມີລາຍການໃນກະຕ່າ', zh: '购物车暂无商品', en: 'Cart is empty' },
  empty_menu: { th: 'ไม่มีเมนู', lo: 'ບໍ່ມີເມນູ', zh: '暂无菜品', en: 'No items' },
  placeholder_customer_name: { th: 'ลูกค้า', lo: 'ລູກຄ້າ', zh: '顾客', en: 'Customer' },

  modal_choose_options_title: { th: 'เลือกตัวเลือก', lo: 'ເລືອກຕົວເລືອກ', zh: '选择选项', en: 'Choose options' },
  placeholder_notes_staff: { th: 'เช่น ไม่ใส่ผัก', lo: 'ເຊັ່ນ: ບໍ່ໃສ່ຜັກ', zh: '例如：不要放蔬菜', en: 'e.g. No vegetables' },

  err_pw_new_len: { th: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร', lo: 'ລະຫັດຜ່ານໃໝ່ຕ້ອງຍາວຢ່າງໜ້ອຍ 6 ຕົວອັກສອນ', zh: '新密码长度至少需要6个字符', en: 'New password must be at least 6 characters' },
  err_username_len: { th: 'ชื่อผู้ใช้ต้องยาวอย่างน้อย 3 ตัวอักษร', lo: 'ຊື່ຜູ້ໃຊ້ຕ້ອງຍາວຢ່າງໜ້ອຍ 3 ຕົວອັກສອນ', zh: '用户名长度至少需要3个字符', en: 'Username must be at least 3 characters' },
  err_branch_name_required: { th: 'กรุณาใส่ชื่อสาขา', lo: 'ກະລຸນາໃສ່ຊື່ສາຂາ', zh: '请输入分店名称', en: 'Please enter a branch name' },
  err_table_name_required: { th: 'กรุณาใส่ชื่อโต๊ะ', lo: 'ກະລຸນາໃສ່ຊື່ໂຕະ', zh: '请输入桌台名称', en: 'Please enter a table name' },
  err_category_name_required: { th: 'กรุณาใส่ชื่อหมวดหมู่', lo: 'ກະລຸນາໃສ່ຊື່ໝວດໝູ່', zh: '请输入分类名称', en: 'Please enter a category name' },
  err_menu_item_name_required: { th: 'กรุณาใส่ชื่อเมนู', lo: 'ກະລຸນາໃສ່ຊື່ເມນູ', zh: '请输入菜品名称', en: 'Please enter an item name' },
  err_cart_empty_min1: { th: 'กรุณาเลือกเมนูอย่างน้อย 1 รายการ', lo: 'ກະລຸນາເລືອກເມນູຢ່າງໜ້ອຍ 1 ລາຍການ', zh: '请至少选择一项菜品', en: 'Please choose at least 1 item' },
  err_choose_option_group: { th: 'กรุณาเลือก', lo: 'ກະລຸນາເລືອກ', zh: '请选择', en: 'Please choose' },

  confirm_delete_branch: { th: 'ยืนยันการลบสาขานี้?', lo: 'ຢືນຢັນການລຶບສາຂານີ້?', zh: '确认删除此分店？', en: 'Delete this branch?' },
  confirm_delete_table: { th: 'ยืนยันการลบโต๊ะนี้?', lo: 'ຢືນຢັນການລຶບໂຕະນີ້?', zh: '确认删除此桌台？', en: 'Delete this table?' },
  confirm_delete_category: { th: 'ยืนยันการลบหมวดหมู่นี้?', lo: 'ຢືນຢັນການລຶບໝວດໝູ່ນີ້?', zh: '确认删除此分类？', en: 'Delete this category?' },
  confirm_delete_menu_item: { th: 'ยืนยันการลบเมนูนี้?', lo: 'ຢືນຢັນການລຶບເມນູນີ້?', zh: '确认删除此菜品？', en: 'Delete this menu item?' },
  confirm_deactivate_user: { th: 'ยืนยันการปิดใช้งานบัญชีนี้?', lo: 'ຢືນຢັນການປິດໃຊ້ງານບັນຊີນີ້?', zh: '确认停用此账户？', en: 'Deactivate this account?' },
  confirm_suspend_tenant: { th: 'ยืนยันการระงับร้านค้านี้?', lo: 'ຢືນຢັນການລະງັບຮ້ານນີ້?', zh: '确认停用此商户？', en: 'Suspend this shop?' },

  toast_saved: { th: 'บันทึกแล้ว', lo: 'ບັນທຶກແລ້ວ', zh: '已保存', en: 'Saved' },
  toast_deleted: { th: 'ลบแล้ว', lo: 'ລຶບແລ້ວ', zh: '已删除', en: 'Deleted' },
  toast_password_changed: { th: 'เปลี่ยนรหัสผ่านสำเร็จ', lo: 'ປ່ຽນລະຫັດຜ່ານສຳເລັດ', zh: '密码修改成功', en: 'Password changed' },
  toast_username_changed: { th: 'เปลี่ยนชื่อผู้ใช้สำเร็จ', lo: 'ປ່ຽນຊື່ຜູ້ໃຊ້ສຳເລັດ', zh: '用户名修改成功', en: 'Username changed' },
  toast_deactivated: { th: 'ปิดใช้งานแล้ว', lo: 'ປິດໃຊ້ງານແລ້ວ', zh: '已停用', en: 'Deactivated' },
  toast_tenant_created: { th: 'สร้างร้านค้าใหม่แล้ว', lo: 'ສ້າງຮ້ານໃໝ່ແລ້ວ', zh: '新商户已创建', en: 'New shop created' },
  toast_tenant_suspended: { th: 'ระงับร้านค้าแล้ว', lo: 'ລະງັບຮ້ານແລ້ວ', zh: '商户已停用', en: 'Shop suspended' },
  toast_tables_created: { th: 'สร้าง {n} โต๊ะแล้ว', lo: 'ສ້າງ {n} ໂຕະແລ້ວ', zh: '已创建 {n} 张桌台', en: 'Created {n} tables' },
  toast_order_saved: { th: 'บันทึกออเดอร์ #{no} แล้ว', lo: 'ບັນທຶກອໍເດີ #{no} ແລ້ວ', zh: '订单 #{no} 已保存', en: 'Order #{no} saved' },

  // ---------- customer ordering page (order.html + order.js) ----------
  loading_menu: { th: 'กำลังโหลดเมนู...', lo: 'ກຳລັງໂຫຼດເມນູ...', zh: '菜单加载中...', en: 'Loading menu...' },
  cart_fab_count: { th: '{n} รายการ', lo: '{n} ລາຍການ', zh: '{n} 件', en: '{n} items' },
  cart_title: { th: 'ตะกร้าของคุณ', lo: 'ກະຕ່າຂອງທ່ານ', zh: '您的购物车', en: 'Your cart' },
  label_order_type_title: { th: 'ประเภทการสั่ง', lo: 'ປະເພດການສັ່ງ', zh: '订单类型', en: 'Order type' },
  label_your_table: { th: 'โต๊ะของคุณ', lo: 'ໂຕະຂອງທ່ານ', zh: '您的桌号', en: 'Your table' },
  label_pick_table: { th: 'กรุณาเลือกโต๊ะของคุณ', lo: 'ກະລຸນາເລືອກໂຕະຂອງທ່ານ', zh: '请选择您的桌号', en: 'Please select your table' },
  err_pick_table_first: { th: 'กรุณาเลือกโต๊ะก่อนยืนยันออเดอร์', lo: 'ກະລຸນາເລືອກໂຕະກ່ອນຢືນຢັນອໍເດີ', zh: '请先选择桌号再确认下单', en: 'Please select your table before confirming' },
  label_orderer_name: { th: 'ชื่อผู้สั่ง', lo: 'ຊື່ຜູ້ສັ່ງ', zh: '订餐人姓名', en: 'Your name' },
  placeholder_your_name: { th: 'ชื่อของคุณ', lo: 'ຊື່ຂອງທ່ານ', zh: '您的姓名', en: 'Your name' },
  label_delivery_phone: { th: 'เบอร์โทรติดต่อ', lo: 'ເບີໂທຕິດຕໍ່', zh: '联系电话', en: 'Contact phone' },
  placeholder_phone_example: { th: 'เช่น 020xxxxxxx', lo: 'ເຊັ່ນ: 020xxxxxxx', zh: '例如：020xxxxxxx', en: 'e.g. 020xxxxxxx' },
  label_phone_confirm: { th: 'กรอกเบอร์โทรอีกครั้งเพื่อยืนยัน', lo: 'ປ້ອນເບີໂທອີກຄັ້ງເພື່ອຢືນຢັນ', zh: '请再次输入电话号码以确认', en: 'Re-enter phone number to confirm' },
  placeholder_address: { th: 'บ้านเลขที่ / ถนน / จุดสังเกต', lo: 'ບ້ານເລກທີ / ຖະໜົນ / ຈຸດສັງເກດ', zh: '门牌号 / 街道 / 地标', en: 'House no. / street / landmark' },
  label_phone_optional: { th: 'เบอร์โทร (ถ้ามี — เผื่อร้านต้องการติดต่อ)', lo: 'ເບີໂທ (ຖ້າມີ — ເຜື່ອຮ້ານຕ້ອງການຕິດຕໍ່)', zh: '电话号码（选填，方便商家联系）', en: 'Phone (optional — in case the shop needs to reach you)' },
  label_notes_to_shop: { th: 'หมายเหตุถึงร้าน (ถ้ามี)', lo: 'ໝາຍເຫດເຖິງຮ້ານ (ຖ້າມີ)', zh: '给商家的备注（选填）', en: 'Note to the shop (optional)' },
  placeholder_notes_shop_example: { th: 'เช่น ขอช้อนเพิ่ม', lo: 'ເຊັ່ນ: ຂໍບ່ວງເພີ່ມ', zh: '例如：多要一副餐具', en: 'e.g. Extra spoon please' },
  btn_confirm_order_customer: { th: '✅ ยืนยันสั่งอาหาร', lo: '✅ ຢືນຢັນສັ່ງອາຫານ', zh: '✅ 确认下单', en: '✅ Confirm order' },
  success_title: { th: 'สั่งอาหารสำเร็จ! 🎉', lo: 'ສັ່ງອາຫານສຳເລັດ! 🎉', zh: '下单成功！🎉', en: 'Order placed! 🎉' },
  success_order_no_prefix: { th: 'เลขที่ออเดอร์', lo: 'ເລກທີ່ອໍເດີ', zh: '订单号', en: 'Order number' },
  success_hint: { th: 'ทางร้านได้รับออเดอร์ของคุณแล้ว กรุณารอสักครู่', lo: 'ທາງຮ້ານໄດ້ຮັບອໍເດີຂອງທ່ານແລ້ວ ກະລຸນາລໍຖ້າບຶດໜຶ່ງ', zh: '商家已收到您的订单，请稍候', en: 'The shop has received your order — please wait a moment' },
  btn_track_order: { th: '📍 ติดตามสถานะออเดอร์', lo: '📍 ຕິດຕາມສະຖານະອໍເດີ', zh: '📍 追踪订单状态', en: '📍 Track order status' },
  btn_order_more: { th: '🍽️ สั่งเพิ่ม', lo: '🍽️ ສັ່ງເພີ່ມ', zh: '🍽️ 继续点餐', en: '🍽️ Order more' },
  empty_menu_category: { th: 'ยังไม่มีเมนูในหมวดนี้', lo: 'ຍັງບໍ່ມີເມນູໃນໝວດນີ້', zh: '该分类暂无菜品', en: 'No items in this category yet' },
  label_notes_optional: { th: 'หมายเหตุ (ถ้ามี)', lo: 'ໝາຍເຫດ (ຖ້າມີ)', zh: '备注（选填）', en: 'Notes (optional)' },
  placeholder_notes_customer: { th: 'เช่น ไม่ใส่ผัก ไม่เผ็ด', lo: 'ເຊັ່ນ: ບໍ່ໃສ່ຜັກ ບໍ່ເຜັດ', zh: '例如：不要蔬菜，不要辣', en: 'e.g. No vegetables, not spicy' },
  btn_add_to_cart_price: { th: 'เพิ่มลงตะกร้า —', lo: 'ເພີ່ມໃສ່ກະຕ່າ —', zh: '加入购物车 —', en: 'Add to cart —' },
  err_shop_not_found: { th: 'ไม่พบข้อมูลร้าน กรุณาสแกน QR โค้ดที่โต๊ะอีกครั้ง', lo: 'ບໍ່ພົບຂໍ້ມູນຮ້ານ ກະລຸນາສະແກນ QR ໂຄດທີ່ໂຕະອີກຄັ້ງ', zh: '找不到店铺信息，请重新扫描桌台二维码', en: 'Shop not found — please scan the table QR code again' },
  toast_added_to_cart: { th: 'เพิ่มลงตะกร้าแล้ว', lo: 'ເພີ່ມໃສ່ກະຕ່າແລ້ວ', zh: '已加入购物车', en: 'Added to cart' },
  empty_cart_customer: { th: 'ตะกร้าว่างเปล่า', lo: 'ກະຕ່າວ່າງເປົ່າ', zh: '购物车是空的', en: 'Your cart is empty' },
  err_customer_name_required: { th: 'กรุณากรอกชื่อผู้สั่ง', lo: 'ກະລຸນາປ້ອນຊື່ຜູ້ສັ່ງ', zh: '请输入订餐人姓名', en: 'Please enter your name' },
  err_phone_both_required: { th: 'กรุณากรอกเบอร์โทรทั้งสองช่อง', lo: 'ກະລຸນາປ້ອນເບີໂທທັງສອງຊ່ອງ', zh: '请填写两个电话号码栏位', en: 'Please fill in both phone number fields' },
  err_phone_mismatch: { th: 'เบอร์โทรทั้งสองช่องไม่ตรงกัน กรุณาตรวจสอบอีกครั้ง', lo: 'ເບີໂທທັງສອງຊ່ອງບໍ່ກົງກັນ ກະລຸນາກວດສອບອີກຄັ້ງ', zh: '两次输入的电话号码不一致，请重新检查', en: 'The phone numbers don’t match — please check again' },
  err_no_tables_setup: { th: 'ร้านยังไม่ได้ตั้งค่าโต๊ะ กรุณาติดต่อพนักงาน', lo: 'ຮ້ານຍັງບໍ່ໄດ້ຕັ້ງຄ່າໂຕະ ກະລຸນາຕິດຕໍ່ພະນັກງານ', zh: '店铺尚未设置桌台，请联系服务员', en: 'The shop hasn’t set up tables yet — please ask staff for help' },

  // ---------- track page (track.html + track.js) ----------
  track_title: { th: 'ติดตามสถานะออเดอร์', lo: 'ຕິດຕາມສະຖານະອໍເດີ', zh: '追踪订单状态', en: 'Track order status' },
  label_order_no: { th: 'เลขที่ออเดอร์', lo: 'ເລກທີ່ອໍເດີ', zh: '订单号', en: 'Order number' },
  placeholder_order_no_example: { th: 'เช่น Z-20260920-0001', lo: 'ເຊັ່ນ: Z-20260920-0001', zh: '例如：Z-20260920-0001', en: 'e.g. Z-20260920-0001' },
  label_phone_used: { th: 'เบอร์โทรที่ใช้ตอนสั่ง', lo: 'ເບີໂທທີ່ໃຊ້ຕອນສັ່ງ', zh: '下单时使用的电话号码', en: 'Phone number used when ordering' },
  btn_check_status: { th: '🔍 ตรวจสอบสถานะ', lo: '🔍 ກວດສອບສະຖານະ', zh: '🔍 查询状态', en: '🔍 Check status' },
  err_fill_order_phone: { th: 'กรุณากรอกเลขที่ออเดอร์และเบอร์โทร', lo: 'ກະລຸນາປ້ອນເລກທີ່ອໍເດີແລະເບີໂທ', zh: '请填写订单号和电话号码', en: 'Please enter the order number and phone number' },
  err_order_not_found: { th: 'ไม่พบออเดอร์ กรุณาตรวจสอบเลขที่ออเดอร์และเบอร์โทรอีกครั้ง', lo: 'ບໍ່ພົບອໍເດີ ກະລຸນາກວດສອບເລກທີ່ອໍເດີແລະເບີໂທອີກຄັ້ງ', zh: '未找到订单，请重新检查订单号和电话号码', en: 'Order not found — please check the order number and phone number again' },
  label_payment_status: { th: 'สถานะการชำระเงิน', lo: 'ສະຖານະການຈ່າຍເງິນ', zh: '付款状态', en: 'Payment status' },

  // ---------- kitchen board (kitchen.html + kitchen.js) ----------
  kitchen_header_title: { th: '👨‍🍳 หน้าจอครัว', lo: '👨‍🍳 ໜ້າຈໍຄົວ', zh: '👨‍🍳 厨房显示屏', en: '👨‍🍳 Kitchen display' },
  kitchen_login_sub: { th: 'เข้าสู่ระบบพนักงานเพื่อดูคิวออเดอร์ครัว', lo: 'ເຂົ້າສູ່ລະບົບພະນັກງານເພື່ອເບິ່ງຄິວອໍເດີຄົວ', zh: '员工登录以查看厨房订单队列', en: 'Staff login to view the kitchen order queue' },
  select_all_branches: { th: 'ทุกสาขา', lo: 'ທຸກສາຂາ', zh: '所有分店', en: 'All branches' },
  empty_kitchen_queue: { th: 'ยังไม่มีออเดอร์ในคิว', lo: 'ຍັງບໍ່ມີອໍເດີໃນຄິວ', zh: '队列中暂无订单', en: 'No orders in the queue yet' },
  kt_btn_start: { th: '👨‍🍳 เริ่มทำ', lo: '👨‍🍳 ເລີ່ມເຮັດ', zh: '👨‍🍳 开始制作', en: '👨‍🍳 Start cooking' },
  kt_btn_ready: { th: '✅ พร้อมเสิร์ฟ', lo: '✅ ພ້ອມເສີບ', zh: '✅ 可以上菜', en: '✅ Ready to serve' },
  kt_btn_served: { th: '🍽️ เสิร์ฟแล้ว', lo: '🍽️ ເສີບແລ້ວ', zh: '🍽️ 已上菜', en: '🍽️ Served' },
  kt_btn_cancel: { th: '✕ ยกเลิก', lo: '✕ ຍົກເລີກ', zh: '✕ 取消', en: '✕ Cancel' },
};

function getLang() {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved && LANGS.some(l => l.code === saved)) return saved;
  } catch (e) { /* localStorage unavailable */ }
  return null;
}
function setLangStorage(code) {
  try { localStorage.setItem(LANG_STORAGE_KEY, code); } catch (e) { /* ignore */ }
}
function localeFor(code) {
  const l = LANGS.find(x => x.code === code);
  return l ? l.locale : 'en-US';
}

let currentLang = getLang() || (typeof DEFAULT_LANG !== 'undefined' ? DEFAULT_LANG : 'th');
const _langChangeListeners = [];
const _langSwitcherEls = []; // every <select> wired via initLangSwitcher, kept in sync with each other
function onLangChange(fn) { _langChangeListeners.push(fn); }

function t(key, vars) {
  const entry = I18N[key];
  let str = entry ? (entry[currentLang] || entry.th || entry.en || key) : key;
  if (vars) {
    Object.keys(vars).forEach(k => { str = str.replace('{' + k + '}', vars[k]); });
  }
  return str;
}

function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  scope.querySelectorAll('[data-i18n-ph]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  scope.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  document.documentElement.setAttribute('lang', currentLang);
}

function setLang(code) {
  if (!LANGS.some(l => l.code === code)) return;
  currentLang = code;
  setLangStorage(code);
  applyI18n();
  _langSwitcherEls.forEach(el => { el.value = code; });
  _langChangeListeners.forEach(fn => { try { fn(code); } catch (e) { /* ignore listener errors */ } });
}

function initLangSwitcher(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.innerHTML = LANGS.map(l => `<option value="${l.code}">${l.label}</option>`).join('');
  el.value = currentLang;
  el.addEventListener('change', () => setLang(el.value));
  _langSwitcherEls.push(el);
}
