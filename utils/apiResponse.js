export function ok(res, { message = "", data = null, legacy = {}, status = 200 } = {}) {
  const payload = {
    success: true,
    message,
    data,
    ...legacy,
  };
  return res.status(status).json(payload);
}

export function fail(res, { message = "Request failed", data = null, legacy = {}, status = 400, error = undefined } = {}) {
  const payload = {
    success: false,
    message,
    data,
    ...legacy,
  };
  if (error) payload.error = error;
  return res.status(status).json(payload);
}

