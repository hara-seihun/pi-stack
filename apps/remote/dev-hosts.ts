export function devAllowedHosts(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((host) => {
    const name = host.trim();
    if (!/^(?:\.?[a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9_-]+)*$/.test(name) || name === "true") {
      throw new Error(`PI_REMOTE_DEV_ALLOWED_HOSTS must contain comma-separated hostnames, not ${JSON.stringify(name)}`);
    }
    return name;
  });
}
