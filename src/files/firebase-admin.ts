import admin from 'firebase-admin';

const bucketName = 'gs://codeit-beginner-project.firebasestorage.app';

const getFirebaseBucket = () => {
  const firebaseConfig = process.env.FIREBASE_CONFIG;
  if (!firebaseConfig) {
    throw new Error('FIREBASE_CONFIG is required to upload files.');
  }

  const serviceAccount: unknown = JSON.parse(firebaseConfig);
  if (typeof serviceAccount !== 'object' || serviceAccount === null) {
    throw new Error('FIREBASE_CONFIG must contain a service-account JSON object.');
  }

  if ('private_key' in serviceAccount && typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: bucketName,
    });
  }

  return admin.storage().bucket();
};

export default getFirebaseBucket;
