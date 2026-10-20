export const validate = (schema, source = 'body') => (req, res, next) => {
  const r = schema.safeParse(req[source]);
  if (!r.success) return next(r.error);
  req.valid = { ...(req.valid || {}), [source]: r.data };
  next();
};
