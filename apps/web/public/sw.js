self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || 'Sales Control', {
    body: data.body || 'Есть новое событие',
    icon: '/sales/icon.svg',
    badge: '/sales/icon.svg',
    tag: data.tag || 'sales-control',
    renotify: true,
    data: { url: data.url || '/sales/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/sales/', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      existing.navigate(target);
      return existing.focus();
    }
    return clients.openWindow(target);
  }));
});
