import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const failures = new Rate('request_failures');
const latency = new Trend('api_latency_ms');
const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
const token = __ENV.AUTH_TOKEN || '';

export const options = {
  stages: [
    { duration: '30s', target: 5 },
    { duration: '1m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<800'],
    request_failures: ['rate<0.02'],
  },
};

export default function () {
  const response = http.get(`${baseUrl}/health`);
  latency.add(response.timings.duration);
  failures.add(response.status !== 200);
  check(response, { 'health responde 200': (r) => r.status === 200 });

  if (token) {
    const authResponse = http.get(`${baseUrl}/election-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    check(authResponse, { 'status eleitoral responde sem erro de autenticação': (r) => r.status !== 401 });
  }
  sleep(1);
}
