/**
 * Internationalization core.
 *
 * Three persisted language modes: English ("en"), playful Hong Kong-style
 * Cantonese ("yue"), and bilingual ("bi", English primary plus a compact
 * Cantonese secondary). Per-language funny levels (1 serious .. 5 maximum)
 * style VOICE ONLY - numbers, paths, error text and outcomes inside `text`
 * pass through unchanged at every level, in every category including errors.
 *
 * While School mode is active the presentation forces English, funny effects
 * drop to level 1, and personal vocabulary replacements are suspended. The
 * school module registers its live checker through registerSchoolProvider().
 */

import { store } from './store.js';

/* ------------------------------ Catalogs --------------------------------- */

const CAT_EN = {
  'app.title': 'Material Roblox',
  'app.tagline': 'A Material You companion for Roblox lookups',

  'tabs.home': 'Home',
  'tabs.users': 'Users',
  'tabs.friends': 'Friends',
  'tabs.groups': 'Groups',
  'tabs.games': 'Games',
  'tabs.marketplace': 'Marketplace',
  'tabs.inventory': 'Inventory',
  'tabs.economy': 'Economy',
  'tabs.presence': 'Presence',
  'tabs.session': 'Session',
  'tabs.compare': 'Compare',
  'tabs.settings': 'Settings',
  'tabs.history': 'History',
  'tabs.converter': 'Converter',
  'tabs.ollama': 'Local models',
  'tabs.authenticator': 'Authenticator',

  'common.search': 'Search',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.retry': 'Retry',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.export': 'Export',
  'common.import': 'Import',
  'common.refresh': 'Refresh',
  'common.connect': 'Connect',
  'common.disconnect': 'Disconnect',
  'common.loading': 'Loading…',
  'common.noResults': 'No results',
  'common.selectAll': 'Select all',
  'common.selectAllPage': 'Select all on this page',
  'common.selectAllAll': 'Select every match',
  'common.invert': 'Invert selection',
  'common.selectedCount': '{{count}} selected',
  'common.next': 'Next',
  'common.prev': 'Previous',
  'common.open': 'Open',
  'common.download': 'Download',
  'common.checkForUpdates': 'Check for updates',
  'common.later': 'Later',
  'common.emergencyExit': 'Emergency exit',
  'common.lock': 'Lock',
  'common.unlock': 'Unlock',
  'common.editAppearance': 'Edit appearance…',
  'common.recover': 'Recover',
  'common.apply': 'Apply',
  'common.reset': 'Reset',
  'common.preview': 'Preview',
  'common.bulkClose': 'Close tabs…',
  'common.moveToGroup': 'Move… into group…',
  'common.duplicate': 'Duplicate',
  'common.pin': 'Pin',
  'common.unpin': 'Unpin',
  'common.newGroup': 'New group',
  'common.renameGroup': 'Rename group',

  'settings.group.appearance': 'Appearance',
  'settings.group.language': 'Language',
  'settings.group.narrator': 'Narrator',
  'settings.group.school': 'School mode',
  'settings.group.privacy': 'Privacy',
  'settings.group.notifications': 'Notifications',
  'settings.group.advanced': 'Advanced',
  'settings.provenance.user': 'Set by you',
  'settings.provenance.default': 'Default: {{value}}',
  'settings.resetOne': 'Reset this setting',
  'settings.resetGroup': 'Reset group',
  'settings.resetAll': 'Reset all settings',
  'settings.searchPlaceholder': 'Search settings',
  'settings.overrideBadge': 'Temporary override active',
  'settings.groupsNav': 'Setting groups',

  'dialogs.unsavedTitle': 'Discard unsaved changes?',
  'dialogs.unsavedBody':
    'This tab has work that has not been saved. Discarding cannot be undone.',
  'dialogs.discard': 'Discard',
  'dialogs.cancel': 'Cancel',

  'notify.center': 'Notification centre',
  'notify.dismissAll': 'Dismiss all',
  'notify.empty': 'Nothing here yet. Notifications you dismiss collect here.',

  'history.title': 'History',
  'history.restore': 'Restore',
  'history.label': 'Label',
  'history.labelPrompt': 'Describe what changed',
  'history.prune': 'Prune',
  'history.filterAction': 'Filter by action',
  'history.from': 'From',
  'history.to': 'To',
  'history.noEntries': 'No history entries match these filters.',

  'ladder.dishPrompt': 'Which dim sum dish is this?',
  'ladder.sumsPrompt': 'Ten quick sums. Get them all right to skip the wait.',
  'ladder.molePrompt': 'Hit the moles before the round ends.',
  'ladder.wonFooter': 'Wait cleared. Sign-in still needs your password.',
  'ladder.clockFallback': 'The ladder is resting. Please wait out the clock.',
  'ladder.budgetLeft': '{{count}} ladder skips left this hour',

  'locks.wizardTitle': 'Lock this element',
  'locks.wizardStep1': 'Choose a method',
  'locks.wizardStep2': 'Create the credential',
  'locks.wizardStep3': 'Pick the unlock duration',
  'locks.wizardStep4': 'Confirm',
  'locks.methodPassword': 'Password',
  'locks.methodOtp': 'One-time code (TOTP)',
  'locks.unlockPrompt': 'Enter the credential for this lock',
  'locks.wrongAttempt': 'That did not match. The recovery route is below.',
  'locks.lockAgain': 'Lock again',
  'locks.lockedOnLaunch': 'Locked on launch',
  'locks.durationSurface': 'Until this surface closes',
  'locks.durationMinutes': '{{count}} minutes',
  'locks.supportTickets.title': 'Support Tickets',
  'locks.supportTickets.body':
    'Describe what happened and a ticket number will be minted locally.',
  'locks.supportTickets.category': 'Category',
  'locks.supportTickets.create': 'Create ticket',
  'locks.supportTickets.openFolder': 'Open the app data folder',
  'locks.supportTickets.pathLabel': 'Folder to remove',
  'locks.supportTickets.disclosure':
    'Nothing is sent anywhere. No ticket exists outside this computer. No network request is made. No data is collected. Nobody is reading this.',
  'locks.recoveryLine':
    'Forgot it? Deleting the folder below resets every lock: {path}',

  'auth.addEntry': 'Add entry',
  'auth.issuer': 'Issuer',
  'auth.account': 'Account',
  'auth.secret': 'Secret',
  'auth.manualEntry': 'Type the secret manually',
  'auth.pasteUri': 'Paste an otpauth:// link',
  'auth.readQr': 'Read a QR image',
  'auth.confirmPair': 'Confirm pairing',
  'auth.confirmPrompt': 'Type one current code to finish pairing',
  'auth.liveCode': 'Current code',
  'auth.nextCode': 'Next code',
  'auth.countdown': '{{seconds}}s',
  'auth.skewWarning':
    'Your clock looks offset from typical time servers. Codes may be rejected elsewhere.',
  'auth.exportOmits': 'Export omits registered secrets and says so.',
  'auth.secretsExportWarn': 'This writes usable secrets in the clear.',

  'adhd.focus.name': 'Focus spotlight',
  'adhd.focus.desc': 'Dims everything except what you are working on.',
  'adhd.lowStim.name': 'Low stimulation',
  'adhd.lowStim.desc': 'Quieter colours, no extra motion, fewer interruptions.',
  'adhd.timeAwareness.name': 'Time awareness',
  'adhd.timeAwareness.desc': 'Shows how long this session has been open.',
  'adhd.oneThing.name': 'One thing at a time',
  'adhd.oneThing.desc': 'A single visible next action that you choose.',
  'adhd.momentum.name': 'Momentum nudges',
  'adhd.momentum.desc': 'A gentle prompt when something sits untouched, with a real snooze.',
  'adhd.notNow': 'Not now',
  'adhd.snooze': 'Snooze 30 minutes',

  'dimsum.cardTitle': 'Dim sum surprise',
  'dimsum.alt': 'Photo of {{dish}}',
  'dimsum.dismiss': 'Dismiss',

  'vocab.upload': 'Personal vocabulary file',
  'vocab.noFile': 'No file loaded. Original wording is shown.',
  'vocab.loaded': 'Loaded {{count}} replacements',
  'vocab.invalid': 'That file does not match the expected schema.',
  'vocab.tooLarge': 'That file is too large.',
  'vocab.clear': 'Clear vocabulary',
  'vocab.replace': 'Replace file',

  'converter.documents': 'Documents / PDF',
  'converter.images': 'Images',
  'converter.audio': 'Audio',
  'converter.video': 'Video',
  'converter.archives': 'Archives',
  'converter.data': 'Structured data',
  'converter.code': 'Code / Text',
  'converter.binary': 'Binary encodings',
  'converter.pickSource': 'Choose a source file',
  'converter.convert': 'Convert',
  'converter.queue': 'Queue',
  'converter.pause': 'Pause',
  'converter.resume': 'Resume',
  'converter.unavailable': 'Unavailable: {{reason}}',
  'converter.done': 'Converted {{ok}}, failed {{failed}}',

  'ollama.state.missing': 'Not installed',
  'ollama.state.stopped': 'Service stopped',
  'ollama.state.unhealthy': 'Responding but unwell',
  'ollama.state.offline': 'Offline',
  'ollama.state.stale': 'Catalog stale',
  'ollama.state.noSpace': 'Not enough free disk space',
  'ollama.state.gpuUnsupported': 'GPU or driver unsupported',
  'ollama.troubleshoot': 'Troubleshoot',
  'ollama.pull': 'Pull model',
  'ollama.chat': 'Chat',
  'ollama.runsWell': 'Runs well',
  'ollama.runsWithLimits': 'Runs with limits',
  'ollama.unlikely': 'Unlikely',
  'ollama.unknownFit': 'Unknown',

  'updates.checking': 'Checking for updates…',
  'updates.upToDate': 'You are up to date.',
  'updates.downloading': 'Downloading update… {{percent}}%',
  'updates.ready': 'Update ready: version {{version}}',
  'updates.restartToInstall': 'Restart to install update',
  'updates.unsignedWarning':
    'This update is unsigned; your operating system may show an unknown-publisher warning.',
  'updates.failure': 'The update check failed. Your app still works.',

  'schedule.newRule': 'New rule',
  'schedule.everyDay': 'Every day',
  'schedule.weekdays': 'Selected weekdays',
  'schedule.start': 'Start',
  'schedule.end': 'End',
  'schedule.timezoneNote': 'Times use your local timezone, including daylight saving.',
  'schedule.crossMidnightNote': 'Windows may cross midnight; the later boundary wins.',
  'schedule.precedenceNote': 'When rules overlap, the most recently enabled one wins.',

  'session.connectTitle': 'Connect your Roblox session',
  'session.pasteLabel': 'Paste your .ROBLOSECURITY cookie value',
  'session.saveAndVerify': 'Save and verify',
  'session.verifyOk': 'Connected as {{name}}',
  'session.disclosure':
    'Stored encrypted by the operating system credential vault. Never logged, never exported, never shown again in full.',
  'session.securityNotes.title': 'What is stored',
  'session.securityNotes.storedLocally':
    'Only the session cookie, encrypted by the OS vault, on this machine.',
  'session.securityNotes.neverLogged': 'It never appears in logs or exports.',
  'session.securityNotes.clearAnytime': 'Disconnect removes it immediately.',

  'errors.network': 'The network said no. Check your connection and try again.',
  'errors.notFound': 'That record does not exist (or is not public).',
  'errors.rateLimited': 'Too many requests. Waiting a moment usually fixes it.',
  'errors.sessionRequired': 'This needs a connected session. Open the Session tab.',
  'errors.privateInventory': 'That inventory is private, so it cannot be listed here.',
  'errors.serviceDown': 'The service is having a moment. Try again shortly.',
  'errors.storageFull': 'Local storage is full.',
  'errors.storageFullHint': 'Free some space in Settings > Advanced or export and clear old data.',

  'palette.open': 'Command palette',
  'palette.placeholder': 'Type a command or setting…',
  'palette.shortcutDesc': 'Open the command palette',
  'palette.unavailable': 'The command palette is not installed in this build.',

  'boot.failedTitle': '{{count}} feature(s) failed to start',
  'home.placeholderTitle': 'Welcome to Material Roblox',
  'home.placeholderBody':
    'Roblox surfaces are provided by their own modules. This placeholder keeps Home usable until they register.',
  'home.openSettings': 'Open settings',
  'shortcuts.title': 'Keyboard shortcuts',
};

const CAT_YUE = {
  'app.title': 'Material Roblox',
  'app.tagline': '用 Material 設計睇 Roblox 資料嘅好幫手',

  'tabs.home': '主頁',
  'tabs.users': '用戶',
  'tabs.friends': '朋友',
  'tabs.groups': '群組',
  'tabs.games': '遊戲',
  'tabs.marketplace': '市集',
  'tabs.inventory': '物品欄',
  'tabs.economy': '經濟',
  'tabs.presence': '在線狀態',
  'tabs.session': '登入工作階段',
  'tabs.compare': '比較',
  'tabs.settings': '設定',
  'tabs.history': '歷史',
  'tabs.converter': '檔案轉換',
  'tabs.ollama': '本地模型',
  'tabs.authenticator': '驗證器',

  'common.search': '搜尋',
  'common.cancel': '取消',
  'common.save': '儲存',
  'common.close': '關閉',
  'common.delete': '刪除',
  'common.retry': '再試一次',
  'common.copy': '複製',
  'common.copied': '複製咗喇',
  'common.export': '匯出',
  'common.import': '匯入',
  'common.refresh': '重新整理',
  'common.connect': '連接',
  'common.disconnect': '斷開',
  'common.loading': '載入中…',
  'common.noResults': '搵唔到結果',
  'common.selectAll': '全部揀齊',
  'common.selectAllPage': '揀晒呢一頁',
  'common.selectAllAll': '揀晒所有符合',
  'common.invert': '調轉選擇',
  'common.selectedCount': '揀咗 {{count}} 個',
  'common.next': '下一個',
  'common.prev': '上一個',
  'common.open': '開啟',
  'common.download': '下載',
  'common.checkForUpdates': '檢查更新',
  'common.later': '遲啲先',
  'common.emergencyExit': '緊急出口',
  'common.lock': '上鎖',
  'common.unlock': '解鎖',
  'common.editAppearance': '編輯外觀…',
  'common.recover': '復原',
  'common.apply': '套用',
  'common.reset': '重設',
  'common.preview': '預覽',
  'common.bulkClose': '大量關閉分頁…',
  'common.moveToGroup': '搬入…群組…',
  'common.duplicate': '建立副本',
  'common.pin': '釘選',
  'common.unpin': '取消釘選',
  'common.newGroup': '新增群組',
  'common.renameGroup': '改群組名',

  'settings.group.appearance': '外觀',
  'settings.group.language': '語言',
  'settings.group.narrator': '語音旁白',
  'settings.group.school': '專注模式',
  'settings.group.privacy': '私隱',
  'settings.group.notifications': '通知',
  'settings.group.advanced': '進階',
  'settings.provenance.user': '你自己設定嘅',
  'settings.provenance.default': '預設值：{{value}}',
  'settings.resetOne': '重設呢一項',
  'settings.resetGroup': '重設成組',
  'settings.resetAll': '重設所有設定',
  'settings.searchPlaceholder': '搜尋設定',
  'settings.overrideBadge': '暫時覆寫生效中',
  'settings.groupsNav': '設定分組',

  'dialogs.unsavedTitle': '未儲存嘅嘢要唔要掉？',
  'dialogs.unsavedBody': '呢個分頁有未儲存嘅嘢，掉咗就救唔返。',
  'dialogs.discard': '掉咗佢',
  'dialogs.cancel': '取消',

  'notify.center': '通知中心',
  'notify.dismissAll': '全部收埋',
  'notify.empty': '仲未有嘢。熄咗嘅通知會喺度收集。',

  'history.title': '歷史',
  'history.restore': '還原',
  'history.label': '標記',
  'history.labelPrompt': '講低改咗乜',
  'history.prune': '清理',
  'history.filterAction': '按動作篩選',
  'history.from': '由',
  'history.to': '至',
  'history.noEntries': '冇歷史記錄符合呢個篩選。',

  'ladder.dishPrompt': '呢籠點心係邊款？',
  'ladder.sumsPrompt': '十條小學數，全中就免等。',
  'ladder.molePrompt': '喺限時內打中啲地鼠。',
  'ladder.wonFooter': '等完喇。不過簽入照舊要你個密碼。',
  'ladder.clockFallback': '小遊戲休息紧，請等個鐘行完。',
  'ladder.budgetLeft': '今個鐘頭淨返 {{count}} 次跳等機會',

  'locks.wizardTitle': '鎖起呢個元件',
  'locks.wizardStep1': '揀方法',
  'locks.wizardStep2': '整憑證',
  'locks.wizardStep3': '揀解鎖時長',
  'locks.wizardStep4': '確認',
  'locks.methodPassword': '密碼',
  'locks.methodOtp': '一次性驗證碼（TOTP）',
  'locks.unlockPrompt': '輸入呢把鎖嘅憑證',
  'locks.wrongAttempt': '唔對辦。下面有後備路線。',
  'locks.lockAgain': '再上鎖',
  'locks.lockedOnLaunch': '每次啟動都鎖',
  'locks.durationSurface': '直到呢個介面關閉',
  'locks.durationMinutes': '{{count}} 分鐘',
  'locks.supportTickets.title': '支援服務台',
  'locks.supportTickets.body': '講低發生咗乜，本機就會開張戲飛編號出嚟。',
  'locks.supportTickets.category': '類別',
  'locks.supportTickets.create': '開戲飛',
  'locks.supportTickets.openFolder': '打開應用程式資料夾',
  'locks.supportTickets.pathLabel': '要刪走嘅資料夾',
  'locks.supportTickets.disclosure':
    '乜都唔會送出去。呢張戲飛除咗呢部機邊度都唔存在。唔會發任何網絡請求。唔會收集任何資料。冇人會睇。',
  'locks.recoveryLine': '唔記得記得咗？刪走下面呢個資料夾就重設所有鎖：{path}',

  'auth.addEntry': '加入項目',
  'auth.issuer': '服務名',
  'auth.account': '帳戶',
  'auth.secret': '密鑰',
  'auth.manualEntry': '人手輸入密鑰',
  'auth.pasteUri': '貼上 otpauth:// 連結',
  'auth.readQr': '讀取 QR 圖片',
  'auth.confirmPair': '確認配對',
  'auth.confirmPrompt': '輸入現時其中一個驗證碼完成配對',
  'auth.liveCode': '現時驗證碼',
  'auth.nextCode': '下一個碼',
  'auth.countdown': '{{seconds}} 秒',
  'auth.skewWarning': '你部機嘅時鐘似乎有偏差，第啲地方可能會話你個碼錯。',
  'auth.exportOmits': '匯出唔包含密鑰，而且會講明。',
  'auth.secretsExportWarn': '咁做會將可以用嘅密鑰以明文寫出嚟。',

  'adhd.focus.name': '專注聚光燈',
  'adhd.focus.desc': '將你做緊嘅嘢以外全部調暗。',
  'adhd.lowStim.name': '低刺激',
  'adhd.lowStim.desc': '色調靜啲、無多餘動畫、打擾少啲。',
  'adhd.timeAwareness.name': '時間感知',
  'adhd.timeAwareness.desc': '顯示今次開咗幾耐。',
  'adhd.oneThing.name': '一次一件',
  'adhd.oneThing.desc': '只顯示一件你自己揀嘅下一步。',
  'adhd.momentum.name': '動力提示',
  'adhd.momentum.desc': '有嘢擺耐咗就輕輕提你，可以真 snooze。',
  'adhd.notNow': '而家唔得',
  'adhd.snooze': '半個鐘後再提',

  'dimsum.cardTitle': '點心彩蛋',
  'dimsum.alt': '{{dish}} 嘅相',
  'dimsum.dismiss': '收埋',

  'vocab.upload': '個人詞彙表檔案',
  'vocab.noFile': '未載入檔案，顯示原本字眼。',
  'vocab.loaded': '載入咗 {{count}} 個替換',
  'vocab.invalid': '呢個檔案唔合乎預期格式。',
  'vocab.tooLarge': '呢個檔案太大喇。',
  'vocab.clear': '清空詞彙表',
  'vocab.replace': '換檔案',

  'converter.documents': '文件 / PDF',
  'converter.images': '圖片',
  'converter.audio': '音訊',
  'converter.video': '影片',
  'converter.archives': '壓縮檔',
  'converter.data': '結構化資料',
  'converter.code': '程式碼 / 文字',
  'converter.binary': '二進制編碼',
  'converter.pickSource': '揀來源檔案',
  'converter.convert': '轉換',
  'converter.queue': '隊列',
  'converter.pause': '暫停',
  'converter.resume': '繼續',
  'converter.unavailable': '用唔到：{{reason}}',
  'converter.done': '成功 {{ok}}，失敗 {{failed}}',

  'ollama.state.missing': '未安裝',
  'ollama.state.stopped': '服務停咗',
  'ollama.state.unhealthy': '有回應但唔舒服',
  'ollama.state.offline': '離線',
  'ollama.state.stale': '目錄過期',
  'ollama.state.noSpace': '硬碟空間不足',
  'ollama.state.gpuUnsupported': '顯示卡或驅動不支援',
  'ollama.troubleshoot': '排難解紛',
  'ollama.pull': '拉取模型',
  'ollama.chat': '傾偈',
  'ollama.runsWell': '行得順',
  'ollama.runsWithLimits': '勉強行到',
  'ollama.unlikely': '多數唔得',
  'ollama.unknownFit': '未知',

  'updates.checking': '檢查更新中…',
  'updates.upToDate': '已經係最新。',
  'updates.downloading': '下載更新中… {{percent}}%',
  'updates.ready': '更新準備好：版本 {{version}}',
  'updates.restartToInstall': '重新啟動以安裝更新',
  'updates.unsignedWarning':
    '呢個更新未經簽署；作業系統可能會顯示「發行者不明」警告。',
  'updates.failure': '檢查更新失敗。應用程式照常用得。',

  'schedule.newRule': '新規則',
  'schedule.everyDay': '每日',
  'schedule.weekdays': '指定星期幾',
  'schedule.start': '開始',
  'schedule.end': '結束',
  'schedule.timezoneNote': '時間用你本機時區，包括夏令時間。',
  'schedule.crossMidnightNote': '時段可以過午夜；以較遲嗰端為準。',
  'schedule.precedenceNote': '規則重疊時，最後啟用嗰條優先。',

  'session.connectTitle': '連接你嘅 Roblox 工作階段',
  'session.pasteLabel': '貼上你嘅 .ROBLOSECURITY cookie 值',
  'session.saveAndVerify': '儲存並驗證',
  'session.verifyOk': '已連接：{{name}}',
  'session.disclosure':
    '由作業系統憑證保管庫加密儲存。唔會入日誌、唔會匯出、唔會再完整顯示。',
  'session.securityNotes.title': '儲存咗乜',
  'session.securityNotes.storedLocally': '只有工作階段 cookie，經系統加密，留喺本機。',
  'session.securityNotes.neverLogged': '永遠唔會出現喺日誌或匯出。',
  'session.securityNotes.clearAnytime': '斷開即時移除。',

  'errors.network': '網絡話唔得。檢查下連線再試。',
  'errors.notFound': '搵唔到呢筆資料（或者唔係公開）。 ',
  'errors.rateLimited': '請求太密。等一陣通常就得。',
  'errors.sessionRequired': '要先連接工作階段。去 Session 分頁啦。',
  'errors.privateInventory': '呢個物品欄係私人嘅，列唔到出嚟。',
  'errors.serviceDown': '服務頭暈身慶，陣間再試。',
  'errors.storageFull': '本機儲存空間爆咗。',
  'errors.storageFullHint': '去「設定 > 進階」清舊資料，或者匯出之後清除。',

  'palette.open': '指令面板',
  'palette.placeholder': '輸入指令或者設定…',
  'palette.shortcutDesc': '開啟指令面板',
  'palette.unavailable': '呢個版本未裝指令面板。',

  'boot.failedTitle': '{{count}} 個功能啟動失敗',
  'home.placeholderTitle': '歡迎使用 Material Roblox',
  'home.placeholderBody': 'Roblox 各分面由各自模組提供。佢哋註冊之前，呢個主頁頂住先。',
  'home.openSettings': '打開設定',
  'shortcuts.title': '鍵盤快捷鍵',
};

/** Voice wrappers: prefix/suffix styling only; `{text}` stays verbatim. */
const VOICE_EN = {
  info: [
    '{text}',
    '{text}',
    'Heads up - {text}',
    'A dispatch from the machine room: {text}',
    'Breaking news from the server hamsters: {text}',
  ],
  ok: [
    '{text}',
    'Done. {text}',
    '{text} Smooth as the first basket off the steamer.',
    '{text} The machine even tidied up afterwards.',
    '{text} Somebody give this build a little trophy.',
  ],
  warn: [
    '{text}',
    '{text}',
    'Careful now - {text}',
    '{text} Nothing is broken yet; long may it last.',
    '{text} The machine raised one skeptical eyebrow.',
  ],
  error: [
    '{text}',
    '{text}',
    'Something went sideways: {text}',
    'The machine tripped over its own cables: {text}',
    '{text} It has already apologized in binary.',
  ],
  destructive: [
    '{text}',
    'This cannot be undone. {text}',
    'Point of no return ahead. {text}',
    '{text} After this, even undo will shrug.',
    '{text} The delete key cracked its knuckles first.',
  ],
  neutral: [
    '{text}',
    '{text}',
    'For the record: {text}',
    'Filing this under useful: {text}',
    'Hot off the press: {text}',
  ],
};

const VOICE_YUE = {
  info: [
    '{text}',
    '{text}',
    '提提你：{text}',
    '機房小廣播：{text}',
    '伺服器倉鼠有嘢講：{text}',
  ],
  ok: [
    '{text}',
    '搞掂。{text}',
    '{text}，順過飲茶第一籠。',
    '{text}，部機仲自動執手尾。',
    '{text}，今次佢真係好乖。',
  ],
  warn: [
    '{text}',
    '{text}',
    '小心啲——{text}',
    '{text} 暫時無事，保持住。',
    '{text} 部機眼眉挑咗一下。',
  ],
  error: [
    '{text}',
    '{text}',
    '搞唔掂：{text}',
    '部機自己絆親：{text}',
    '{text} 佢已經用二進制道咗歉。',
  ],
  destructive: [
    '{text}',
    '做咗就返唔到轉頭：{text}',
    '前面係不歸路：{text}',
    '{text} 之後連 undo 都幫你唔到。',
    '{text} 個 delete 掣事先鬆咗下手腕。',
  ],
  neutral: [
    '{text}',
    '{text}',
    '記低件事：{text}',
    '有用情報：{text}',
    '新鮮出爐：{text}',
  ],
};

const VOICE_POOLS = { en: VOICE_EN, yue: VOICE_YUE };
const VOICE_CATEGORIES = ['info', 'ok', 'warn', 'error', 'destructive', 'neutral'];

/* ------------------------------- State ------------------------------------ */

let mode = 'en';
let funnyLevels = { en: 5, yue: 5 };
let vocabulary = null;
let vocabularyCount = 0;
let schoolChecker = null;
let vocabularyProvider = null;

/* ------------------------------ Helpers ----------------------------------- */

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined
      ? String(params[name])
      : match
  );
}

function lookup(lang, key) {
  const catalog = lang === 'yue' ? CAT_YUE : CAT_EN;
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  // Fallback chain: requested language, then English, then the key itself.
  if (lang !== 'en' && Object.prototype.hasOwnProperty.call(CAT_EN, key)) {
    return CAT_EN[key];
  }
  return null;
}

function presentationLang() {
  // School mode forces English presentation everywhere.
  if (schoolActive()) return 'en';
  return mode === 'yue' ? 'yue' : 'en';
}

function schoolActive() {
  try {
    return schoolChecker ? schoolChecker() === true : false;
  } catch {
    return false;
  }
}

function effectiveFunnyLevel(lang) {
  if (schoolActive()) return 1;
  const level = Number(funnyLevels[lang]);
  if (!Number.isFinite(level)) return 1;
  return Math.min(5, Math.max(1, Math.round(level)));
}

/* ------------------------------- Public API ------------------------------- */

export const i18n = {
  /** Resolve a key with optional {{param}} interpolation. */
  t(key, params) {
    const lang = presentationLang();
    const raw = lookup(lang, key) ?? String(key);
    return i18n.applyVocabulary(interpolate(raw, params));
  },

  /** Both languages for bilingual surfaces: prominent primary + compact secondary. */
  tb(key) {
    const primary = lookup('en', key) ?? String(key);
    const secondary = Object.prototype.hasOwnProperty.call(CAT_YUE, key) ? CAT_YUE[key] : null;
    return { primary: i18n.applyVocabulary(primary), secondary };
  },

  lang() {
    return mode;
  },

  setLang(nextMode) {
    if (!['en', 'yue', 'bi'].includes(nextMode)) return;
    mode = nextMode;
    store.set('i18n.mode', mode);
    try {
      document.documentElement.lang =
        mode === 'yue' && !schoolActive() ? 'zh-Hant' : 'en';
    } catch {
      /* document not ready */
    }
    window.dispatchEvent(new CustomEvent('mrb-lang-changed', { detail: { lang: mode } }));
  },

  /** Funny level 1..5 for one language. */
  funny(lang) {
    return effectiveFunnyLevel(lang === 'yue' ? 'yue' : 'en');
  },

  setFunny(lang, level) {
    const which = lang === 'yue' ? 'yue' : 'en';
    const clamped = Math.min(5, Math.max(1, Math.round(Number(level) || 1)));
    funnyLevels[which] = clamped;
    store.set('i18n.funny', funnyLevels);
  },

  /**
   * Style a message with the per-language funny level for its category.
   * Wrappers add a prefix/suffix around the whole message; the facts inside
   * `text` are never altered.
   */
  voice(category, text) {
    const lang = presentationLang();
    const pools = VOICE_POOLS[lang] || VOICE_EN;
    const cat = VOICE_CATEGORIES.includes(category) ? category : 'neutral';
    const pool = pools[cat] || pools.neutral;
    const level = effectiveFunnyLevel(lang);
    const template = pool[level - 1] || '{text}';
    return template.replace('{text}', String(text));
  },

  schoolActive,

  /** Live suppression hook; the school module registers its own checker. */
  registerSchoolProvider(fn) {
    schoolChecker = typeof fn === 'function' ? fn : null;
  },

  /** Personal-vocabulary exit hook applied to every translated string. */
  applyVocabulary(text) {
    if (!vocabulary || vocabulary.size === 0 || schoolActive()) return text;
    let output = String(text);
    for (const [from, to] of vocabulary) {
      if (from) {
        output = output.split(from).join(to);
      }
    }
    return output;
  },

  /** Called by the personal-vocabulary lane to install its transform. */
  setVocabularyProvider(fn) {
    vocabularyProvider = typeof fn === 'function' ? fn : null;
  },

  /**
   * Load and validate a personal vocabulary file. Bounds: <= 256 KiB raw,
   * <= 5000 entries, flat string-to-string mapping, schema version 1.
   * Invalid input fails closed: nothing partial is ever applied.
   */
  async loadVocabularyFile(fileObj) {
    const MAX_BYTES = 256 * 1024;
    const MAX_ENTRIES = 5000;
    try {
      if (!fileObj || typeof fileObj.text !== 'string') {
        return { ok: false, error: 'No readable file content was supplied.' };
      }
      if (fileObj.text.length > MAX_BYTES) {
        return { ok: false, error: 'too-large' };
      }
      const parsed = JSON.parse(fileObj.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'schema' };
      }
      if (parsed.schemaVersion !== 1) {
        return { ok: false, error: 'schema' };
      }
      const replacements = parsed.replacements;
      if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
        return { ok: false, error: 'schema' };
      }
      const pairs = Object.entries(replacements);
      if (pairs.length > MAX_ENTRIES) {
        return { ok: false, error: 'too-many' };
      }
      for (const [from, to] of pairs) {
        if (typeof from !== 'string' || typeof to !== 'string') {
          return { ok: false, error: 'schema' };
        }
      }

      // Longest source first so longer phrases win over their prefixes.
      pairs.sort((a, b) => b[0].length - a[0].length);
      vocabulary = new Map(pairs);
      vocabularyCount = pairs.length;
      store.set('vocabulary.cache', fileObj.text);

      if (vocabularyProvider) {
        try {
          await vocabularyProvider(vocabulary);
        } catch {
          /* the provider's failure must not corrupt the loaded state */
        }
      }
      window.dispatchEvent(
        new CustomEvent('mrb-vocabulary-changed', { detail: { count: vocabularyCount } })
      );
      return { ok: true, count: vocabularyCount };
    } catch (err) {
      void err;
      return { ok: false, error: 'parse' };
    }
  },

  clearVocabulary() {
    vocabulary = null;
    vocabularyCount = 0;
    store.remove('vocabulary.cache');
    window.dispatchEvent(new CustomEvent('mrb-vocabulary-changed', { detail: { count: 0 } }));
  },

  vocabularyLoaded() {
    return vocabularyCount;
  },
};

export async function init() {
  const savedMode = store.get('i18n.mode', 'en');
  if (['en', 'yue', 'bi'].includes(savedMode)) mode = savedMode;

  const savedFunny = store.get('i18n.funny', null);
  if (savedFunny && typeof savedFunny === 'object') {
    for (const which of ['en', 'yue']) {
      const value = Number(savedFunny[which]);
      if (Number.isFinite(value)) {
        funnyLevels[which] = Math.min(5, Math.max(1, Math.round(value)));
      }
    }
  }

  // Re-validate the cached private vocabulary before trusting it; a corrupt
  // or oversized cache falls back silently to shipped wording.
  const cacheText = store.get('vocabulary.cache', null);
  if (typeof cacheText === 'string' && cacheText.length <= 256 * 1024) {
    const result = await i18n.loadVocabularyFile({ name: 'cache', text: cacheText });
    if (!result.ok) {
      store.remove('vocabulary.cache');
      vocabulary = null;
      vocabularyCount = 0;
    }
  }

  try {
    document.documentElement.lang =
      mode === 'yue' && !schoolActive() ? 'zh-Hant' : 'en';
  } catch {
    /* document not ready */
  }
}
