const ACCESS_TOKEN_COOKIE = "accessToken";
const MAX_AGE_SECONDS = 15 * 60; // 15 minutes, matches API JWT expiry

export function setAccessToken(token: string) {
  document.cookie = `${ACCESS_TOKEN_COOKIE}=${token}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=strict`;
}

export function clearAccessToken() {
  document.cookie = `${ACCESS_TOKEN_COOKIE}=; path=/; max-age=0`;
}
