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

// 📁 Хранилище ЧАТОВ (групп), а не пользователей
const CHATS_FILE = path.join(process.cwd(), 'chats.json');

function loadChats() {
    try {
        if (fs.existsSync(CHATS_FILE)) {
            const data = fs.readFileSync(CHATS_FILE, 'utf8');
            return new Set(JSON.parse(data));
        }
    } catch (e) {
        console.error('❌ Ошибка загрузки чатов:', e.message);
    }
    return new Set();
}

function saveChats(chats) {
    try {
        fs.writeFileSync(CHATS_FILE, JSON.stringify([...chats]), 'utf8');
    } catch (e) {
        console.error('❌ Ошибка сохранения чатов:', e.message);
    }
}

let registeredChats = loadChats();

// Регистрируем ЧАТ (группу), а не пользователя
function registerChat(chatId) {
    if (!registeredChats.has(chatId)) {
        registeredChats.add(chatId);
        saveChats(registeredChats);
        console.log(`✅ Группа ${chatId} добавлена в рассылку`);
    }
}

//  Рассылка в ГРУППЫ
async function broadcastToChats(text) {
    console.log(`📢 Рассылка: "${text}" для ${registeredChats.size} групп`);
    
    for (const chatId of registeredChats) {
        try {
            await index.sendMessage(chatId, text, { parse_mode: 'HTML' });
            console.log(`✅ Доставлено в чат ${chatId}`);
        } catch (err) {
            console.warn(`⚠️ Не удалось отправить в чат ${chatId}:`, err.message);
            // Если бота удалили из чата — убираем из списка
            if (err.response?.body?.error_code === 403) {
                console.log(`⚠️ Чат ${chatId} заблокировал бота — удаляем из рассылки`);
                registeredChats.delete(chatId);
                saveChats(registeredChats);
            }
        }
        await new Promise(res => setTimeout(res, 30));
    }
}

console.log('🚀 Бот запущен...');

index.getMe().then((user) => {
    console.log(`✅ Авторизован как: @${user.username}`);
}).catch(err => console.error('❌ Ошибка авторизации:', err.message));

// 🕛 Ежедневная рассылка в 12:00 (поменяй 12 на 22, если нужно)
cron.schedule('0 12 * * *', () => {
    console.log('⏰ Время рассылки: 12:00');
    broadcastToChats('🏪 <b>Зайдите к торговцу!</b>\nНе забудьте забрать ежедневные награды! ⚔️');
}, {
    timezone: 'Europe/Moscow'
});

console.log('📅 Запланирована ежедневная рассылка на 12:00');

// --- ФУНКЦИЯ ПРОВЕРКИ АДМИНА ---
async function isAdmin(chatId, userId) {
    try {
        const admins = await index.getChatAdministrators(chatId);
        return admins.some(admin => admin.user.id === userId);
    } catch (error) {
        console.error('Ошибка проверки прав:', error.message);
        return false;
    }
}

// 1. Команда /start
index.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name;
    
    // Если это группа — регистрируем её для рассылки
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        registerChat(chatId);
    }

    index.sendMessage(chatId, `Привет, ${userName}! 👋\nЯ бот для сбора на клановые ивенты.\n\n🔔 **Каждый день в 12:00** я буду напоминать: "Зайдите к торговцу!"\n💡 *Напиши /start в группе, чтобы добавить её в рассылку*\n\n**Только админы** управляют сбором.\n⚔️ Все могут участвовать.\n\nКоманды:\n/event_start [сек] - Начать (по умолчанию 5 мин)\n/event_stop - Отменить`);
});

// 2. Запуск ивента: /event_start [секунды]
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

    activeEvents[chatId] = {
        participants: [],
        startTime: Date.now(),
        duration: durationSec * 1000
    };

    index.sendMessage(chatId, `📢 **АДМИН ЗАПУСТИЛ СБОР НА ИВЕНТ!**\n⏳ Время сбора: ${Math.floor(durationSec / 60)} мин.\n\nНажмите кнопку ниже, чтобы записаться!`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: "⚔️ Я в деле!", callback_data: "join_event" }]]
        }
    }).then((sentMessage) => {
        activeEvents[chatId].msgId = sentMessage.message_id;
    });

    const timerId = setTimeout(() => finishEvent(chatId), durationSec * 1000);
    activeEvents[chatId].timerId = timerId;
});

// 3. Обработка кнопки
index.on('callback_query', (query) => {
    if (query.data === 'join_event') {
        joinEvent(query.message.chat.id, query.from.id, query.from.first_name, query.message.message_id, query.id);
    }
});

// 4. Ручное присоединение /join
index.onText(/\/join/, (msg) => {
    if (activeEvents[msg.chat.id]) {
        joinEvent(msg.chat.id, msg.from.id, msg.from.first_name, null, null);
    } else {
        index.sendMessage(msg.chat.id, '❌ Нет активного сбора.');
    }
});

function joinEvent(chatId, userId, userName, messageId = null, queryId = null) {
    const event = activeEvents[chatId];
    if (!event) return;

    if (event.participants.some(p => p.id === userId)) {
        if (queryId) index.answerCallbackQuery(queryId, { text: 'Вы уже в списке!', show_alert: true });
        else index.sendMessage(chatId, 'Вы уже записаны! ✅');
        return;
    }

    event.participants.push({ id: userId, name: userName });
    const count = event.participants.length;
    const timeLeft = Math.max(0, Math.ceil((event.duration - (Date.now() - event.startTime)) / 1000));

    if (messageId && queryId) {
        const newText = `📢 **СБОР НА ИВЕНТ**\n⏳ Осталось: ${timeLeft} сек.\n👥 Участников: ${count}\n\nПоследний присоединился: ${userName}`;

        index.editMessageText(newText, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⚔️ Я в деле!", callback_data: "join_event" }]] }
        }).catch(() => {});

        index.answerCallbackQuery(queryId, { text: 'Вы успешно добавлены! ⚔️' });
    } else {
        index.sendMessage(chatId, `✅ ${userName} присоединился! (Всего: ${count})`);
    }
}

// 5. Остановка /event_stop
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

// Финал ивента
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

        finalMessage = `🔥 **КЛАНОВЫЙ ИВЕНТ НАЧИНАЕТСЯ!** 🔥\n\n⚔️ Пора в бой!\n\n👥 **Список участников (${count}):**\n${mentionList}\n\n⚠️ **ВАЖНОЕ ПРЕДУПРЕЖДЕНИЕ:**\nВсе, кто записался в список выше, обязаны явиться!\n❌ <b>В случае неявки без уважительной причины — обязательный отчет перед администрацией!</b>`;
    }

    index.sendMessage(chatId, finalMessage, { parse_mode: 'HTML' }).catch(err => {
        if (err.response && err.response.body.description.includes('have no rights')) {
            index.sendMessage(chatId, '⚠️ ОШИБКА: Дайте боту права админа для упоминаний!');
        }
    });
}

index.on('polling_error', (error) => {
    console.warn('⚠️ Ошибка сети:', error.code);
});