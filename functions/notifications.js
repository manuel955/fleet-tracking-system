const admin = require('firebase-admin');

// Push generico solo-datos (sin bloque `notification`) a proposito, mismo
// motivo que notifyAssignedDriver original: asi el handler de background
// de cada app corre siempre y decide como mostrar la alerta (canal, TTS,
// etc.) segun el `type`, en vez de que el sistema operativo muestre una
// notificacion generica. Best-effort: un push fallido no debe romper el
// flujo que lo dispara (la escritura en RTDB que lo motivo ya quedo hecha
// y las apps la ven igual por polling).
async function sendPush(fcmToken, type, data = {}) {
  if (!fcmToken) return;
  try {
    await admin.messaging().send({
      token: fcmToken,
      data: { type, ...data },
      android: { priority: 'high' },
    });
  } catch (e) {
    console.error(`FCM (${type}) fallo: ${e.message || e}`);
  }
}

module.exports = { sendPush };
