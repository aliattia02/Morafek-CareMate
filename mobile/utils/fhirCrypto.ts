/**
 * mobile/utils/fhirCrypto.ts
 *
 * FHIR bundle encryption / decryption utilities.
 *
 * Uses only the Web Crypto API (crypto.subtle), which is available globally
 * in Expo SDK 54 / React Native 0.81 with the Hermes engine.
 * No native modules and no third-party crypto libraries are required.
 *
 * DSGVO / GDPR design principle
 * ─────────────────────────────
 * The AES-256-GCM key is generated fresh for every bundle and is never
 * persisted on-device.  Only the base64-encoded raw key material is placed
 * inside the QR code (qrPayload).  The encrypted file (cipherBytes /
 * cacheDirectory blob) is worthless without the QR code, and the QR code
 * is worthless without the encrypted file — minimising the data exposure
 * surface in line with the principle of data minimisation (Art. 5 DSGVO).
 */

import * as FileSystem from 'expo-file-system';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Encode a Uint8Array to a standard base64 string (no URL-safe variant). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a standard base64 string to a Uint8Array. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypts a FHIR bundle JSON string with AES-256-GCM.
 *
 * DSGVO relevance: the raw key material is returned **only** as part of
 * `qrPayload` and is never written to disk or transmitted over the network.
 * Whoever scans the QR code holds the decryption key; the ciphertext file
 * alone is useless.
 *
 * @param bundleJson - Serialised FHIR Bundle (UTF-8 string).
 * @returns
 *   - `cipherBytes` — raw AES-GCM ciphertext (to be stored or transmitted).
 *   - `qrPayload`   — `base64(rawKey) + "." + base64(iv)`, placed in the QR.
 */
export async function encryptBundle(
  bundleJson: string
): Promise<{ cipherBytes: Uint8Array; qrPayload: string }> {
  const encoder = new TextEncoder();
  const plainBytes = encoder.encode(bundleJson);

  // Generate a random AES-256-GCM key (non-extractable for the CryptoKey
  // object, but we export raw bytes immediately so the QR can carry them).
  const cryptoKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — we need the raw bytes for the QR payload
    ['encrypt', 'decrypt']
  );

  // Export raw key bytes so they can be embedded in the QR code.
  const rawKeyBuffer = await crypto.subtle.exportKey('raw', cryptoKey);
  const rawKeyBytes = new Uint8Array(rawKeyBuffer);

  // 12-byte IV is the standard recommendation for AES-GCM.
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    plainBytes
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const qrPayload = `${uint8ToBase64(rawKeyBytes)}.${uint8ToBase64(iv)}`;

  return { cipherBytes, qrPayload };
}

/**
 * Decrypts a FHIR bundle that was previously encrypted with {@link encryptBundle}.
 *
 * DSGVO relevance: the key is reconstructed from the QR payload at runtime
 * and is never stored anywhere — decryption is only possible when the patient
 * (or authorised receiver) actively presents the QR code.
 *
 * @param cipherBytes - Raw AES-GCM ciphertext produced by {@link encryptBundle}.
 * @param qrPayload   - The `base64(rawKey) + "." + base64(iv)` string from the QR.
 * @returns The original FHIR Bundle JSON string.
 */
export async function decryptBundle(
  cipherBytes: Uint8Array,
  qrPayload: string
): Promise<string> {
  const dotIndex = qrPayload.indexOf('.');
  if (dotIndex === -1) {
    throw new Error('[fhirCrypto] Invalid qrPayload: missing "." separator');
  }

  const rawKeyBytes = base64ToUint8(qrPayload.slice(0, dotIndex));
  const iv = base64ToUint8(qrPayload.slice(dotIndex + 1));

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable after import
    ['decrypt']
  );

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    cipherBytes
  );

  const decoder = new TextDecoder();
  return decoder.decode(plainBuffer);
}

/**
 * Writes encrypted bundle bytes to the Expo cache directory.
 *
 * DSGVO relevance: only the opaque ciphertext is persisted locally.
 * The key is never written to the file-system — it lives only in the QR code.
 * If the device is lost, the cached file cannot be decrypted without the QR.
 *
 * @param cipherBytes - Raw ciphertext from {@link encryptBundle}.
 * @param filename    - File name (e.g. `"bundle_2024.fhir.enc"`).
 * @returns Local file URI that can be shared via the OS share sheet.
 */
export async function bundleToFile(
  cipherBytes: Uint8Array,
  filename: string
): Promise<string> {
  const fileUri = (FileSystem.cacheDirectory ?? '') + filename;

  // expo-file-system only accepts base64 for binary writes.
  const base64Content = uint8ToBase64(cipherBytes);

  await FileSystem.writeAsStringAsync(fileUri, base64Content, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return fileUri;
}

/**
 * Reads an encrypted bundle file back into a `Uint8Array`.
 *
 * DSGVO relevance: the file contains only ciphertext; without the matching
 * QR payload the bytes reveal nothing about the patient's health data.
 *
 * @param fileUri - Local file URI previously returned by {@link bundleToFile}.
 * @returns Raw ciphertext bytes suitable for passing to {@link decryptBundle}.
 */
export async function fileToBytes(fileUri: string): Promise<Uint8Array> {
  const base64Content = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return base64ToUint8(base64Content);
}
