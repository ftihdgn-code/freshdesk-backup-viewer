import { ClientSecretCredential } from '@azure/identity';
import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } from '@azure/storage-blob';

const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER;
const SAS_TTL_MS = 5 * 60 * 1000;

let cachedCredential = null;
function getCredential() {
  if (!cachedCredential) {
    cachedCredential = new ClientSecretCredential(
      process.env.AZURE_TENANT_ID,
      process.env.AZURE_CLIENT_ID,
      process.env.AZURE_CLIENT_SECRET
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
