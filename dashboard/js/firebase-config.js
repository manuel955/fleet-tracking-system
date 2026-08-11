// Reemplaza con la configuracion de tu proyecto Firebase
// (Firebase Console > Configuracion del proyecto > Tus apps > SDK setup).
const firebaseConfig = {
  apiKey: "AIzaSyABbcM0za__wtLsRm3amZa9P10OciEgkBY",
  authDomain: "rastreoflota-53052.firebaseapp.com",
  databaseURL: "https://rastreoflota-53052-default-rtdb.firebaseio.com",
  projectId: "rastreoflota-53052",
  storageBucket: "rastreoflota-53052.firebasestorage.app",
  messagingSenderId: "940357757237",
  appId: "1:940357757237:web:c8221722733d347132c47c",
  measurementId: "G-MN64N2R9L6"
};

// Operational data is served by the Contabo VPS. Firebase remains here for
// dashboard identity and FCM/legacy configuration during the migration.
// Keeping the URL in the static runtime config avoids putting any secret in
// the dashboard bundle.
window.vpsApiBaseUrl = 'https://api.tucomprass.com';

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.database();
const storage = firebase.storage();
