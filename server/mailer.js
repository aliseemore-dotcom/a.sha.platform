// Отправка писем через Resend (https://resend.com) по обычному HTTP-запросу — без npm-зависимости
// (в Node 22 fetch встроен). Без RESEND_API_KEY отправка молча не срабатывает: и регистрация, и
// сброс пароля всё равно завершаются успешно, а адрес просто не получит письма — это осознанный
// запасной путь для локальной разработки и демо-стенда, а не ошибка.
//
// Важно: без верификации собственного домена на Resend с их тестового адреса
// (onboarding@resend.dev) письма уходят только на email, которым зарегистрирован сам аккаунт
// Resend — остальным адресатам Resend их не доставит. Для реальной рассылки всем пользователям
// нужно верифицировать домен в Resend и указать его в EMAIL_FROM.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? 'A.MORE <onboarding@resend.dev>';

export async function sendMail(to, subject, html) {
  if (!RESEND_API_KEY) return { sent: false, reason: 'no_api_key' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.error(`Не удалось отправить письмо (${res.status}): ${await res.text().catch(() => '')}`);
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true };
  } catch (err) {
    console.error(`Не удалось отправить письмо: ${err.message}`);
    return { sent: false, reason: 'network_error' };
  }
}

export function sendPasswordResetEmail(email, link) {
  return sendMail(email, 'Восстановление пароля — A.MORE',
    `<p>Чтобы задать новый пароль, перейдите по ссылке (действует 24 часа, одноразовая):</p>
     <p><a href="${link}">${link}</a></p>
     <p>Если вы не запрашивали восстановление пароля, просто игнорируйте это письмо.</p>`);
}
