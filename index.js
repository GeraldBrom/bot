import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;

if (!token || token.includes(' ') || token.length < 40) {
    console.error('❌ Ошибка токена');
    process.exit(1);
}

const index = new TelegramBot(token, { polling: true });
const activeEvents = {};

// 📁 Хранилище чатов (групп)
const CHATS_FILE = path.join(process.cwd(), 'chats.json');
function loadChats() {
    try {
        if (fs.existsSync(CHATS_FILE)) {
            return new Set(JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')));
        }
    } catch (e) { console.error('❌ Ошибка загрузки чатов:', e.message); }
    return new Set();
}
function saveChats(chats) {
    try { fs.writeFileSync(CHATS_FILE, JSON.stringify([...chats]), 'utf8'); }
    catch (e) { console.error('❌ Ошибка сохранения чатов:', e.message); }
}
let registeredChats = loadChats();

function registerChat(chatId) {
    if (!registeredChats.has(chatId)) {
        registeredChats.add(chatId);
        saveChats(registeredChats);
        console.log(`✅ Группа ${chatId} добавлена в рассылку`);
    }
}

// 📦 Подписчики
const SUBSCRIBERS_FILE = path.join(process.cwd(), 'subscribers.json');
let subscribers = [];

function loadSubscribers() {
    try {
        if (fs.existsSync(SUBSCRIBERS_FILE)) {
            subscribers = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
            console.log(`👥 Загружено ${subscribers.length} подписчиков`);
        }
    } catch (e) { console.error('❌ Ошибка загрузки subscribers.json:', e.message); }
}
loadSubscribers();

function subscribeUser(userId) {
    if (!subscribers.includes(userId)) {
        subscribers.push(userId);
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers), 'utf8');
        console.log(`✅ Пользователь ${userId} подписался`);
    }
}

function unsubscribeUser(userId) {
    const idx = subscribers.indexOf(userId);
    if (idx !== -1) {
        subscribers.splice(idx, 1);
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers), 'utf8');
        console.log(`❌ Пользователь ${userId} отписался`);
    }
}

// 🎯 Упоминания с разбивкой на пачки
function makeMentionChunks(userIds, chunkSize = 30) {
    const makeMention = (id) => `<a href="tg://user?id=${id}">\u2060</a>`;
    const chunks = [];
    for (let i = 0; i < userIds.length; i += chunkSize) {
        const chunk = userIds.slice(i, i + chunkSize);
        chunks.push(chunk.map(makeMention).join(''));
    }
    return chunks;
}

// Рассылка: группы
async function broadcastToChats(text) {
    console.log(`📢 Рассылка: "${text}" для ${registeredChats.size} групп`);
    
    for (const chatId of registeredChats) {
        try {
            if (subscribers.length > 0) {
                const chunks = makeMentionChunks(subscribers);
                const firstChunk = chunks.shift() || '';
                const fullText = `${firstChunk}\n\n${text}`;
                
                const sent = await index.sendMessage(chatId, fullText, { 
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                console.log(`✅ Доставлено в группу ${chatId}`);

                try {
                    await index.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
                } catch (pinErr) {
                    console.warn(`⚠️ Не удалось закрепить:`, pinErr.message);
                }

                for (const chunk of chunks) {
                    await index.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
                    await new Promise(res => setTimeout(res, 1000));
                }
            } else {
                await index.sendMessage(chatId, text, { parse_mode: 'HTML' });
                console.log(`✅ Доставлено в группу ${chatId} (без упоминаний)`);
            }
        } catch (err) {
            console.warn(`⚠️ Ошибка в группе ${chatId}:`, err.message);
            if (err.response?.body?.error_code === 403) {
                registeredChats.delete(chatId);
                saveChats(registeredChats);
            }
        }
        await new Promise(res => setTimeout(res, 50));
    }
     
}

// 🎯 Отправка с упоминаниями (для ивентов)
async function sendWithMentions(chatId, text, extra = {}) {
    if (subscribers.length === 0) {
        return await index.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
    }
    const chunks = makeMentionChunks(subscribers);
    const firstChunk = chunks.shift() || '';
    const fullText = `${firstChunk}\n\n${text}`;
    
    const sent = await index.sendMessage(chatId, fullText, { 
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra
    });

    for (const chunk of chunks) {
        await index.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
        await new Promise(res => setTimeout(res, 1000));
    }
    return sent;
}

console.log('🚀 Бот запущен...');
index.getMe().then(user => {
    console.log(`✅ Авторизован как: @${user.username}`);
}).catch(err => console.error('❌ Ошибка авторизации:', err.message));

// 🕛 Рассылка в 12:00
cron.schedule('0 12 * * *', () => {
    console.log('⏰ Время рассылки: 12:00');
    broadcastToChats('🏪 <b>Зайдите к торговцу!</b>\nНе забудьте забрать ежедневные награды! ⚔️');
}, { timezone: 'Europe/Moscow' });

// 🧪 ТЕСТ каждые 2 минуты (удали этот блок после тестов!)
// cron.schedule('*/2 * * * *', () => {
//     console.log('🧪 [ТЕСТ] Рассылка каждые 2 минуты');
//     broadcastToChats('🧪 <b>Тест</b>\nПроверка связи. ⚔️');
// }, { timezone: 'Europe/Moscow' });

console.log('📅 Запланирована рассылка на 12:00 + тест каждые 2 мин');

// --- ПРОВЕРКА АДМИНА ---
async function isAdmin(chatId, userId) {
    try {
        const admins = await index.getChatAdministrators(chatId);
        return admins.some(admin => admin.user.id === userId);
    } catch (error) {
        console.error('Ошибка проверки прав:', error.message);
        return false;
    }
}

// 1. Команда /start — с умными кнопками по статусу подписки
index.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Пользователь';
    const userId = msg.from.id;
    
    // 🔹 В группе
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        registerChat(chatId);
        
        const isUserAdmin = await isAdmin(chatId, userId);
        const isSubscribed = subscribers.includes(userId);
        
        // Кнопка подписки/отписки
        const keyboard = [[
            isSubscribed 
                ? { text: "❌ Отписаться", callback_data: `unsub_${userId}` }
                : { text: "✅ Подписаться", callback_data: `sub_${userId}` }
        ]];
        
        // ➕ Админские кнопки
        if (isUserAdmin) {
            keyboard.push(
                [
                    { text: "🚀 Старт ивента", callback_data: "admin_event_start" },
                    { text: "📢 Общий зов", callback_data: "admin_call" }
                ],
                [{ text: "🛑 Стоп ивент", callback_data: "admin_event_stop" }]
            );
        }
        
        const statusText = isSubscribed 
            ? `Привет, ${userName}! 👋\n\n✅ Вы уже подписаны на уведомления!\nМожете отписаться в любой момент.`
            : `Привет, ${userName}! 👋\n\nХочешь получать уведомления о клановых ивентах?`;
        
        index.sendMessage(chatId, statusText, {
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'HTML'
        });
        return;
    }
    
    // 🔹 В личных сообщениях
    if (msg.chat.type === 'private') {
        index.sendMessage(chatId, `Привет, ${userName}! 👋\n\nЧтобы подписаться — напиши /start в группе.`, {
            parse_mode: 'HTML'
        });
    }
});

index.on('callback_query', async (query) => {
    // 🔹 Подписка: sub_USERID
    if (query.data?.startsWith('sub_')) {
        const targetUserId = parseInt(query.data.replace('sub_', ''));
        
        if (query.from.id !== targetUserId) {
            await safeAnswerCallback(query, '⛔ Это не ваша кнопка', true);
            return;
        }
        
        await safeAnswerCallback(query, '✅ Вы подписаны!');
        await safeEditMarkup(query, { inline_keyboard: [] });
        
        subscribeUser(targetUserId);
        await index.sendMessage(query.message.chat.id, 
            `✅ Готово, ${query.from.first_name}! Теперь вы будете получать уведомления.\nОтписаться: /unsubscribe`
        );
        return;
    }
    
    // 🔹 Отписка: unsub_USERID (НОВОЕ!)
    if (query.data?.startsWith('unsub_')) {
        const targetUserId = parseInt(query.data.replace('unsub_', ''));
        
        if (query.from.id !== targetUserId) {
            await safeAnswerCallback(query, '⛔ Это не ваша кнопка', true);
            return;
        }
        
        await safeAnswerCallback(query, '❌ Вы отписаны!');
        await safeEditMarkup(query, { inline_keyboard: [] });
        
        unsubscribeUser(targetUserId);
        await index.sendMessage(query.message.chat.id, 
            `❌ ${query.from.first_name}, вы отписаны от уведомений.\nПодписаться снова: /start`
        );
        return;
    }
    
    // 🔹 Админские кнопки
    if (query.data === 'admin_event_start') {
        const isUserAdmin = await isAdmin(query.message.chat.id, query.from.id);
        if (!isUserAdmin) {
            return index.answerCallbackQuery(query.id, { text: '⛔ У вас нет прав', show_alert: true });
        }
        index.sendMessage(query.message.chat.id, '⚡ Быстрый старт ивента на 5 минут...\nИспользуйте /event_stop для остановки.');
        // Здесь можно вызвать логику /event_start 300, если нужно
        return index.answerCallbackQuery(query.id, { text: '🚀 Ивент запущен!' });
    }

    if (query.data === 'admin_call') {
        const isUserAdmin = await isAdmin(query.message.chat.id, query.from.id);
        if (!isUserAdmin) {
            return index.answerCallbackQuery(query.id, { text: '⛔ У вас нет прав', show_alert: true });
        }
        const callMessage = '📢 <b>ОДИН ЗОВЕТ СВОИХ ВОИНОВ!</b> ⚔️\n\n⏳ Собирайтесь срочно!';
        await sendWithMentions(query.message.chat.id, callMessage);
        return index.answerCallbackQuery(query.id, { text: '📢 Зов отправлен!' });
    }

    if (query.data === 'admin_event_stop') {
        const chatId = query.message.chat.id;
        const isUserAdmin = await isAdmin(chatId, query.from.id);
        if (!isUserAdmin) {
            return index.answerCallbackQuery(query.id, { text: '⛔ У вас нет прав', show_alert: true });
        }
        if (activeEvents[chatId]) {
            clearTimeout(activeEvents[chatId].timerId);
            delete activeEvents[chatId];
            index.sendMessage(chatId, '🛑 Сбор отменен администратором.');
        } else {
            index.sendMessage(chatId, 'Нет активного сбора.');
        }
        return index.answerCallbackQuery(query.id, { text: '✅ Остановлено' });
    }
    
    // 🔹 Ивент: присоединиться
    if (query.data === 'join_event') {
        joinEvent(
            query.message.chat.id, 
            query.from.id, 
            query.from.first_name || 'User', 
            query.message.message_id, 
            query.id
        );
        return;
    }
});

// 🛡️ Вспомогательная функция: безопасный ответ на callback
async function safeAnswerCallback(query, text = '', show_alert = false) {
    try {
        await index.answerCallbackQuery(query.id, { text, show_alert });
    } catch (err) {
        // Игнорируем "устаревшие" запросы — это нормально
        const desc = err.response?.body?.description;
        if (desc && (
            desc.includes('query is too old') || 
            desc.includes('timeout expired') || 
            desc.includes('query ID is invalid')
        )) {
            return; // Не считаем это ошибкой
        }
        console.warn('⚠️ Ошибка answerCallbackQuery:', err.message);
    }
}

// 🛡️ Вспомогательная функция: безопасное редактирование клавиатуры
async function safeEditMarkup(query, markup) {
    try {
        const chatId = query.message?.chat?.id;
        const messageId = query.message?.message_id;
        
        if (!chatId || !messageId) {
            console.warn('⚠️ Нет chat_id или message_id для редактирования');
            return;
        }

        await index.editMessageReplyMarkup(markup, {
            chat_id: chatId,
            message_id: messageId
        });
    } catch (err) {
        const desc = err.response?.body?.description;
        // Игнорируем частые "безопасные" ошибки
        if (desc && (
            desc.includes('message is not modified') ||
            desc.includes('message can\'t be edited') ||
            desc.includes('message identifier is not specified') ||
            desc.includes('query is too old') ||
            desc.includes('timeout expired')
        )) {
            return;
        }
        console.warn('⚠️ Ошибка editMessageReplyMarkup:', err.message);
    }
}

// Команда /unsubscribe (работает везде)
index.onText(/\/unsubscribe/, (msg) => {
    unsubscribeUser(msg.from.id);
    index.sendMessage(msg.chat.id, '✅ Вы отписаны. Чтобы подписаться снова: /start');
});

// 2. Запуск ивента
index.onText(/\/event_start(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const durationSec = parseInt(match[1]) || 300;

    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
        index.sendMessage(chatId, 'Эта команда работает только в группах!');
        return;
    }

    const isUserAdmin = await isAdmin(chatId, userId);
    if (!isUserAdmin) {
        index.sendMessage(chatId, '⛔ У вас нет прав. Только админы могут запускать ивент.');
        return;
    }

    if (activeEvents[chatId]) {
        index.sendMessage(chatId, '⚠️ Сбор уже идет! Используйте /event_stop.');
        return;
    }

    console.log(`📢 Админ ${msg.from.first_name} запустил сбор на ${durationSec} сек.`);
    activeEvents[chatId] = { participants: [], startTime: Date.now(), duration: durationSec * 1000 };

    // Исправленная часть: callback_data: вместо callback_
    await sendWithMentions(chatId, `📢 **АДМИН ЗАПУСТИЛ СБОР НА ИВЕНТ!**\n⏳ Время сбора: ${Math.floor(durationSec / 60)} мин.\n\nНажмите кнопку ниже, чтобы записаться!`, {
        reply_markup: {
            inline_keyboard: [[{ text: "⚔️ Я в деле!", callback_data: "join_event" }]]
        }
    }).then((sentMessage) => {
        activeEvents[chatId].msgId = sentMessage.message_id;
    });

    const timerId = setTimeout(() => finishEvent(chatId), durationSec * 1000);
    activeEvents[chatId].timerId = timerId;
});

// 3. /join
index.onText(/\/join/, (msg) => {
    if (activeEvents[msg.chat.id]) {
        joinEvent(msg.chat.id, msg.from.id, msg.from.first_name, null, null);
    } else {
        index.sendMessage(msg.chat.id, '❌ Нет активного сбора.');
    }
});

// 🛡️ Обновлённая безопасная функция (универсальная)
async function safeEditMarkupById(chatId, messageId, markup) {
    try {
        if (!chatId || !messageId) return;
        
        await index.editMessageReplyMarkup(markup, {
            chat_id: chatId,
            message_id: messageId
        });
    } catch (err) {
        const desc = err.response?.body?.description;
        if (desc && (
            desc.includes('message is not modified') ||
            desc.includes('message can\'t be edited') ||
            desc.includes('message identifier is not specified') ||
            desc.includes('query is too old') ||
            desc.includes('timeout expired')
        )) {
            return;
        }
        console.warn('⚠️ Ошибка editMessageReplyMarkup:', err.message);
    }
}

function joinEvent(chatId, userId, userName, messageId = null, queryId = null) {
    const event = activeEvents[chatId];
    if (!event) return;

    if (event.participants.some(p => p.id === userId)) {
        if (queryId) safeAnswerCallback(queryId, 'Вы уже в списке!', true);
        else index.sendMessage(chatId, 'Вы уже записаны! ✅');
        return;
    }

    event.participants.push({ id: userId, name: userName });
    const count = event.participants.length;
    const timeLeft = Math.max(0, Math.ceil((event.duration - (Date.now() - event.startTime)) / 1000));

    if (messageId && queryId) {
        const newText = `📢 **СБОР НА ИВЕНТ**\n⏳ Осталось: ${timeLeft} сек.\n👥 Участников: ${count}\n\nПоследний присоединился: ${userName}`;
        
        // ✅ Обновляем кнопку
        safeEditMarkupById(chatId, messageId, { 
            inline_keyboard: [[{ text: "⚔️ Я в деле!", callback_data: "join_event" }]] 
        });
        
        // ✅ Обновляем текст сообщения
        index.editMessageText(newText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { 
                inline_keyboard: [[{ text: "⚔️ Я в деле!", callback_data: "join_event" }]] 
            }
        }).catch(() => {});
        
        safeAnswerCallback(queryId, 'Вы успешно добавлены! ⚔️');
    } else {
        index.sendMessage(chatId, `✅ ${userName} присоединился! (Всего: ${count})`);
    }
}

// 4. /event_stop
index.onText(/\/event_stop/, async (msg) => {
    const chatId = msg.chat.id;
    const isUserAdmin = await isAdmin(chatId, msg.from.id);
    if (!isUserAdmin) {
        index.sendMessage(chatId, '⛔ Только админы могут остановить сбор.');
        return;
    }
    if (activeEvents[chatId]) {
        clearTimeout(activeEvents[chatId].timerId);
        delete activeEvents[chatId];
        index.sendMessage(chatId, '🛑 Сбор отменен администратором.');
    } else {
        index.sendMessage(chatId, 'Нет активного сбора.');
    }
});

// 5. Общий зов (только для админов)
index.onText(/\/call/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // 🔒 Работает только в группах
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
        return index.sendMessage(chatId, '⛔ Эта команда работает только в группах!');
    }

    // 🔒 Проверка прав админа
    const isUserAdmin = await isAdmin(chatId, userId);
    if (!isUserAdmin) {
        return index.sendMessage(chatId, '⛔ Только админы могут использовать общий зов!');
    }

    // 🔍 Проверка подписчиков
    if (subscribers.length === 0) {
        return index.sendMessage(chatId, '⚠️ В группе пока нет подписчиков на уведомления.');
    }

    // 📝 Текст зова
    const callMessage = '📢 <b>ОДИН ЗОВЕТ СВОИХ ВОИНОВ!</b> ⚔️\n\n⏳ Собирайтесь срочно! Не оставайтесь в стороне. А иначе (T_T) ';

    console.log(`📢 Админ ${msg.from.first_name} запустил общий зов в группе ${chatId} (${subscribers.length} подписчиков)`);

    try {
        // 📡 Отправка с упоминаниями (автоматически разбивает на чанки)
        await sendWithMentions(chatId, callMessage);
        
        // ✅ Подтверждение в чат (опционально)
        // index.sendMessage(chatId, `✅ Общий зов отправлен! Упомянуто ${subscribers.length} участников.`);
    } catch (err) {
        console.error('❌ Ошибка при отправке общего зова:', err.message);
        index.sendMessage(chatId, '⚠️ Произошла ошибка при рассылке зова.');
    }
});

// Финал ивента — только в группу!
function finishEvent(chatId) {
    const event = activeEvents[chatId];
    if (!event) return;
    clearTimeout(event.timerId);
    delete activeEvents[chatId];

    const count = event.participants.length;
    let finalMessage = '';

    if (count === 0) {
        finalMessage = '⏰ Время вышло! Никто не пошел на ивент 😢';
    } else {
        let mentionList = '';
        event.participants.forEach((p, index) => {
            const safeName = p.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            mentionList += `<a href="tg://user?id=${p.id}">${safeName}</a>`;
            if (index < count - 1) mentionList += ', ';
        });
        finalMessage = `🔥 <b>КЛАНОВЫЙ ИВЕНТ НАЧИНАЕТСЯ!</b> 🔥\n\n⚔️ Пора в бой!\n\n👥 <b>Список участников (${count}):</b>\n${mentionList}\n\n⚠️ <b>ВАЖНОЕ ПРЕДУПРЕЖДЕНИЕ:</b>\nВсе, кто записался в список выше, обязаны явиться!\n❌ <b>В случае неявки без уважительной причины — обязательный отчет перед администрацией!</b>`;
    }

    sendWithMentions(chatId, finalMessage).catch(err => {
        if (err.response?.body?.description?.includes('have no rights')) {
            index.sendMessage(chatId, '⚠️ ОШИБКА: Дайте боту права админа для упоминаний!');
        }
    });
}

index.on('polling_error', (error) => {
    console.warn('⚠️ Ошибка сети:', error.code);
});