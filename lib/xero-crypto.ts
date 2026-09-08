import crypto from 'node:crypto'

function key() { return crypto.createHash('sha256').update(process.env.XERO_TOKEN_ENCRYPTION_KEY ?? '').digest() }
export function decrypt(value: string): string {
  const [ivText, tagText, encryptedText] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8')
}
export function encrypt(value: string): string {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}
