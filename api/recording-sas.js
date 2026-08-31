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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (!ACCOUNT || !CONTAINER) {
      return res.status(500).json({ error: 'AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_CONTAINER ayarlanmamış' });
    }

    const blobPath = req.query.path;
    if (!blobPath) return res.status(400).json({ error: 'path gerekli' });

    // TODO(identity): kullanıcının bu kayda erişim yetkisi olup olmadığı burada
    // kontrol edilecek (bkz. reference_azure_blob_verimor_archive.md). Yetki
    // modeli henüz netleşmedi.

    const blobServiceClient = new BlobServiceClient(
      `https://${ACCOUNT}.blob.core.windows.net`,
      getCredential()
    );

    const now = Date.now();
    const startsOn = new Date(now - 60 * 1000); // saat sapması için 1 dk tolerans
    const expiresOn = new Date(now + SAS_TTL_MS);

    const userDelegationKey = await blobServiceClient.getUserDelegationKey(startsOn, expiresOn);

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
    res.status(200).json({ url, expires_at: expiresOn.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
