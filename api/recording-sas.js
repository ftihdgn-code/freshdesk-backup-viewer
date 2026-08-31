import { mintReadSas } from './_azure.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const blobPath = req.query.path;
    if (!blobPath) return res.status(400).json({ error: 'path gerekli' });

    // TODO(identity): kullanıcının bu kayda erişim yetkisi olup olmadığı burada
    // kontrol edilecek (bkz. reference_azure_blob_verimor_archive.md). Yetki
    // modeli henüz netleşmedi.

    const { url, expiresOn } = await mintReadSas(blobPath);
    res.status(200).json({ url, expires_at: expiresOn.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
