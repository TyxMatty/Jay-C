/** Token bucket: allows bursts of `capacity`, refilling `perSecond` tokens/s. */
export class TokenBucket {
  constructor({ capacity, perSecond, now = () => Date.now() }) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  take() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
