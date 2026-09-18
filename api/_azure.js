import fs from 'node:fs';
import { ClientSecretCredential } from '@azure/identity';
import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } from '@azure/storage-blob';

const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER;
const SAS_TTL_MS = 5 * 60 * 1000;

// Production'da Swarm secret olarak /run/secrets/azure_client_secret'a mount
// ediliyor; yerel docker-compose testinde (secret yok) AZURE_CLIENT_SECRET env
// var'ına düşer.
function getClientSecret() {
  const filePath = process.env.AZURE_CLIENT_SECRET_FILE || '/run/secrets/azure_client_secret';
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    // dosya okunamazsa env var'a düş
  }
  return process.env.AZURE_CLIENT_SECRET;
}

let cachedCredential = null;
function getCredential() {
  if (!cachedCredential) {
    cachedCredential = new ClientSecretCredential(
      process.env.AZURE_TENANT_ID,
      process.env.AZURE_CLIENT_ID,
      getClientSecret()
    );
  }
  return cachedCredential;
}

let cachedClient = null;
export function getContainerClient() {
  if (!ACCOUNT || !CONTAINER) {
    throw new Error('AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_CONTAINER ayarlanmamış');
  }
  if (!cachedClient) {
    const blobServiceClient = new BlobServiceClient(`https://${ACCOUNT}.blob.core.windows.net`, getCredential());
    cachedClient = blobServiceClient.getContainerClient(CONTAINER);
  }
  return cachedClient;
}

export async function downloadRangeBuffer(blobName, count) {
  const blobClient = getContainerClient().getBlobClient(blobName);
  const dl = await blobClient.download(0, count);
  const chunks = [];
  for await (const chunk of dl.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function mintReadSas(blobPath) {
  getContainerClient(); // ACCOUNT/CONTAINER env kontrolü için
  const parentServiceClient = new BlobServiceClient(`https://${ACCOUNT}.blob.core.windows.net`, getCredential());

  const now = Date.now();
  const startsOn = new Date(now - 60 * 1000);
  const expiresOn = new Date(now + SAS_TTL_MS);

  const userDelegationKey = await parentServiceClient.getUserDelegationKey(startsOn, expiresOn);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
    },
    userDelegationKey,
    ACCOUNT
  ).toString();

  const url = `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${blobPath.split('/').map(encodeURIComponent).join('/')}?${sas}`;
  return { url, expiresOn };
}
