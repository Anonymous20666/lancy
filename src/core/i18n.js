/**
 * Multi-Language Localization Engine (i18n)
 * Provides translations across English, Spanish, French, Arabic, Portuguese, Russian, and Indonesian.
 */

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'ar', name: 'العربية', flag: '🇸🇦', rtl: true },
  { code: 'pt', name: 'Português', flag: '🇧🇷' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'id', name: 'Bahasa Indonesia', flag: '🇮🇩' }
];

export const LANGUAGE_MAP = new Map(SUPPORTED_LANGUAGES.map((l) => [l.code, l]));

export const TRANSLATIONS = {
  en: {
    welcome_title: '𓆩♡𓆪 WELCOME TO {botName} 𓆩♡𓆪',
    welcome_sub: 'your aesthetic media & music companion ♡',
    select_language: '🌍 <b>Choose Your Preferred Language</b> ♡\nSelect a language below to customize your experience:',
    lang_updated: '✨ Language updated to <b>{langName}</b> ♡',
    group_requested_by: '👤 Requested by {user}',
    send_audio_btn: '🎵 Send Audio File',
    lyrics_btn: '📜 Lyrics',
    identify_btn: '🎧 Identify Song',
    download_btn: '📥 Download Link',
    sticker_btn: '✦ Make Sticker Pack',
    play_another_btn: '🎵 Play Another',
    dashboard_btn: '« Dashboard',
    menu_btn: '« Menu',
    clone_bot_btn: '🤖 Clone Bot',
    delivered_by: 'Delivered with aesthetic love by {botName} ♡',
    group_restricted_notice: '🌸 In group chats, search for music with <code>/play &lt;song&gt;</code>, Pinterest with <code>/pint &lt;query&gt;</code>, or send any media URL to download! ♡'
  },
  es: {
    welcome_title: '𓆩♡𓆪 BIENVENIDO A {botName} 𓆩♡𓆪',
    welcome_sub: 'tu compañero estético de música y medios ♡',
    select_language: '🌍 <b>Elige tu idioma preferido</b> ♡\nSelecciona un idioma a continuación para personalizar tu experiencia:',
    lang_updated: '✨ Idioma actualizado a <b>{langName}</b> ♡',
    group_requested_by: '👤 Solicitado por {user}',
    send_audio_btn: '🎵 Enviar Archivo de Audio',
    lyrics_btn: '📜 Letras',
    identify_btn: '🎧 Identificar Canción',
    download_btn: '📥 Enlace de Descarga',
    sticker_btn: '✦ Crear Pack de Stickers',
    play_another_btn: '🎵 Reproducir Otra',
    dashboard_btn: '« Panel',
    menu_btn: '« Menú',
    clone_bot_btn: '🤖 Clonar Bot',
    delivered_by: 'Entregado con amor estético por {botName} ♡',
    group_restricted_notice: '🌸 ¡En grupos puedes buscar música con <code>/play &lt;canción&gt;</code>, Pinterest con <code>/pint &lt;búsqueda&gt;</code> o enviar enlaces para descargar! ♡'
  },
  fr: {
    welcome_title: '𓆩♡𓆪 BIENVENUE SUR {botName} 𓆩♡𓆪',
    welcome_sub: 'votre compagnon esthétique de musique et médias ♡',
    select_language: '🌍 <b>Choisissez votre langue préférée</b> ♡\nSélectionnez une langue ci-dessous pour personnaliser votre expérience :',
    lang_updated: '✨ Langue mise à jour en <b>{langName}</b> ♡',
    group_requested_by: '👤 Demandé par {user}',
    send_audio_btn: '🎵 Envoyer le Fichier Audio',
    lyrics_btn: '📜 Paroles',
    identify_btn: '🎧 Identifier le Morceau',
    download_btn: '📥 Lien de Téléchargement',
    sticker_btn: '✦ Créer un Pack de Stickers',
    play_another_btn: '🎵 Jouer un Autre',
    dashboard_btn: '« Tableau de Bord',
    menu_btn: '« Menu',
    clone_bot_btn: '🤖 Cloner le Bot',
    delivered_by: 'Livré avec amour esthétique par {botName} ♡',
    group_restricted_notice: '🌸 Dans les groupes, recherchez de la musique avec <code>/play &lt;titre&gt;</code>, Pinterest avec <code>/pint &lt;recherche&gt;</code> ou envoyez un lien pour télécharger ! ♡'
  },
  ar: {
    welcome_title: '𓆩♡𓆪 مرحباً بك في {botName} 𓆩♡𓆪',
    welcome_sub: 'رفيقك الجمالي للموسيقى والوسائط ♡',
    select_language: '🌍 <b>اختر لغتك المفضلة</b> ♡\nحدد لغة من الخيارات أدناه لتخصيص تجربتك:',
    lang_updated: '✨ تم تغيير اللغة إلى <b>{langName}</b> ♡',
    group_requested_by: '👤 تم الطلب بواسطة {user}',
    send_audio_btn: '🎵 إرسال ملف الصوت',
    lyrics_btn: '📜 كلمات الأغنية',
    identify_btn: '🎧 التعرّف على الأغنية',
    download_btn: '📥 رابط التحميل',
    sticker_btn: '✦ صنع حزمة ملصقات',
    play_another_btn: '🎵 تشغيل أغنية أخرى',
    dashboard_btn: '« لوحة التحكم',
    menu_btn: '« القائمة',
    clone_bot_btn: '🤖 استنساخ البوت',
    delivered_by: 'تم التقديم بكل حب وجمال بواسطة {botName} ♡',
    group_restricted_notice: '🌸 في المجموعات، يمكنك البحث عن الموسيقى عبر <code>/play &lt;اسم الأغنية&gt;</code>، وبينترست عبر <code>/pint &lt;البحث&gt;</code> أو إرسال أي رابط للتحميل! ♡'
  },
  pt: {
    welcome_title: '𓆩♡𓆪 BEM-VINDO AO {botName} 𓆩♡𓆪',
    welcome_sub: 'seu companheiro estético de música e mídia ♡',
    select_language: '🌍 <b>Escolha seu idioma de preferência</b> ♡\nSelecione um idioma abaixo para personalizar sua experiência:',
    lang_updated: '✨ Idioma atualizado para <b>{langName}</b> ♡',
    group_requested_by: '👤 Solicitado por {user}',
    send_audio_btn: '🎵 Enviar Arquivo de Áudio',
    lyrics_btn: '📜 Letra',
    identify_btn: '🎧 Identificar Música',
    download_btn: '📥 Link de Download',
    sticker_btn: '✦ Criar Pacote de Figurinhas',
    play_another_btn: '🎵 Tocar Outra',
    dashboard_btn: '« Painel',
    menu_btn: '« Menu',
    clone_bot_btn: '🤖 Clonar Bot',
    delivered_by: 'Entregue com amor estético por {botName} ♡',
    group_restricted_notice: '🌸 Em grupos, busque música com <code>/play &lt;música&gt;</code>, Pinterest com <code>/pint &lt;busca&gt;</code> ou envie links para baixar! ♡'
  },
  ru: {
    welcome_title: '𓆩♡𓆪 ДОБРО ПОЖАЛОВАТЬ В {botName} 𓆩♡𓆪',
    welcome_sub: 'ваш эстетичный медиа и музыкальный помощник ♡',
    select_language: '🌍 <b>Выберите предпочитаемый язык</b> ♡\nВыберите язык ниже для персонализации бота:',
    lang_updated: '✨ Язык изменен на <b>{langName}</b> ♡',
    group_requested_by: '👤 Запрос от {user}',
    send_audio_btn: '🎵 Отправить аудиофайл',
    lyrics_btn: '📜 Текст песни',
    identify_btn: '🎧 Распознать трек',
    download_btn: '📥 Ссылка на скачивание',
    sticker_btn: '✦ Создать стикерпак',
    play_another_btn: '🎵 Включить другой',
    dashboard_btn: '« Панель',
    menu_btn: '« Меню',
    clone_bot_btn: '🤖 Клонировать бота',
    delivered_by: 'Доставлено с эстетической любовью от {botName} ♡',
    group_restricted_notice: '🌸 В группах можно искать музыку через <code>/play &lt;песня&gt;</code>, Pinterest через <code>/pint &lt;запрос&gt;</code> или присылать ссылки для скачивания! ♡'
  },
  id: {
    welcome_title: '𓆩♡𓆪 SELAMAT DATANG DI {botName} 𓆩♡𓆪',
    welcome_sub: 'teman media dan musik estetik Anda ♡',
    select_language: '🌍 <b>Pilih Bahasa Pilihan Anda</b> ♡\nPilih bahasa di bawah ini untuk menyesuaikan pengalaman Anda:',
    lang_updated: '✨ Bahasa diperbarui ke <b>{langName}</b> ♡',
    group_requested_by: '👤 Diminta oleh {user}',
    send_audio_btn: '🎵 Kirim Berkas Audio',
    lyrics_btn: '📜 Lirik Lagu',
    identify_btn: '🎧 Kenali Lagu',
    download_btn: '📥 Tautan Unduh',
    sticker_btn: '✦ Buat Paket Stiker',
    play_another_btn: '🎵 Putar Lagu Lain',
    dashboard_btn: '« Dasbor',
    menu_btn: '« Menu',
    clone_bot_btn: '🤖 Gandakan Bot',
    delivered_by: 'Dikirim dengan cinta estetik oleh {botName} ♡',
    group_restricted_notice: '🌸 Di grup, cari musik dengan <code>/play &lt;lagu&gt;</code>, Pinterest dengan <code>/pint &lt;kata kunci&gt;</code> atau kirim tautan media untuk mengunduh! ♡'
  }
};

/**
 * Translate a phrase by key, with parameter substitution and fallback to English.
 * @param {string} lang - Language code (e.g. 'en', 'es', 'ar')
 * @param {string} key - Translation key
 * @param {Record<string, string|number>} [params] - Replacement variables
 * @returns {string}
 */
export function t(lang = 'en', key, params = {}) {
  const normLang = String(lang || 'en').toLowerCase().slice(0, 2);
  const dict = TRANSLATIONS[normLang] || TRANSLATIONS.en;
  let text = dict[key] || TRANSLATIONS.en[key] || key;

  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v ?? ''));
  }
  return text;
}

export function getLanguageName(code = 'en') {
  const norm = String(code).toLowerCase().slice(0, 2);
  const found = LANGUAGE_MAP.get(norm);
  return found ? `${found.flag} ${found.name}` : '🇬🇧 English';
}
