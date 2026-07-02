/* DISABLED. This endpoint previously created sub-accounts/users for debugging.
   It has been neutralized for security and is safe to delete entirely. */
export default async function handler(req, res) {
  return res.status(410).json({ error: 'gone: endpoint disabled' });
}
