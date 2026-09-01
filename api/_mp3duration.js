// Dosyanın tamamını indirmeden, sadece ilk birkaç KB'ından bitrate'i okuyup
// (bu kayıtlar CBR — sabit bitrate) toplam boyuttan süreyi hesaplıyoruz.
// VBR dosyalarda yanlış sonuç verir, ama telefon kayıtları için CBR tipik.

const BITRATES_KBPS = {
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};

function findFirstFrameBitrateBps(buf) {
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const b1 = buf[i + 1];
    const b2 = buf[i + 2];

    const versionBits = (b1 >> 3) & 0x03; // 00=MPEG2.5, 01=reserved, 10=MPEG2, 11=MPEG1
    if (versionBits === 1) continue;
    const layerBits = (b1 >> 1) & 0x03; // 00=reserved, 01=III, 10=II, 11=I
    if (layerBits === 0) continue;

    const bitrateIndex = (b2 >> 4) & 0x0f;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f) continue; // free/bad

    const mpegVersion = versionBits === 3 ? 1 : 2; // 2 ve 2.5 aynı bitrate tablosunu kullanır
    const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
    const kbps = BITRATES_KBPS[mpegVersion]?.[layer]?.[bitrateIndex];
    if (!kbps) continue;

    return kbps * 1000;
  }
  return null;
}

export function estimateMp3DurationSeconds(headerBuffer, contentLengthBytes) {
  const bitrateBps = findFirstFrameBitrateBps(headerBuffer);
  if (!bitrateBps) return null;
  return (contentLengthBytes * 8) / bitrateBps;
}

// "Çağrı Süresi: 01:38" / "Call Duration: 1:38" gibi metinlerden saniye çıkarır.
export function parseCallDurationSeconds(text) {
  const m = String(text || '').match(/(?:Çağrı\s*Süresi|Call\s*Duration)\s*:?\s*(\d{1,2}):(\d{2})/i);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
