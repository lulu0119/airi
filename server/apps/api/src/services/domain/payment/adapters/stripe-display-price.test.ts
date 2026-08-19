import { describe, expect, it, vi } from 'vitest'

import { createStripeDisplayPrice } from './stripe'

describe('createStripeDisplayPrice', () => {
  it('returns an empty map when Stripe is not configured', async () => {
    const displayPrice = createStripeDisplayPrice(null)
    await expect(displayPrice.hydrate(['price_1'])).resolves.toEqual(new Map())
  })

  it('hydrates currencies from unit_amount and currency_options', async () => {
    const retrieve = vi.fn(async () => ({
      id: 'price_1',
      currency: 'usd',
      unit_amount: 500,
      currency_options: {
        jpy: { unit_amount: 500 },
      },
    }))
    const displayPrice = createStripeDisplayPrice({
      prices: { retrieve },
    } as any)

    const prices = await displayPrice.hydrate(['price_1', 'price_1', ''])
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledWith('price_1', { expand: ['currency_options'] })
    expect(prices.get('price_1')).toEqual({
      priceId: 'price_1',
      defaultCurrency: 'usd',
      currencies: {
        usd: '$5.00',
        jpy: '¥500',
      },
    })
  })

  it('omits a price id when retrieve fails', async () => {
    const retrieve = vi.fn(async (priceId: string) => {
      if (priceId === 'price_bad')
        throw new Error('not found')
      return {
        id: 'price_ok',
        currency: 'usd',
        unit_amount: 999,
        currency_options: {},
      }
    })
    const displayPrice = createStripeDisplayPrice({
      prices: { retrieve },
    } as any)

    const prices = await displayPrice.hydrate(['price_bad', 'price_ok'])
    expect(prices.has('price_bad')).toBe(false)
    expect(prices.get('price_ok')).toMatchObject({
      priceId: 'price_ok',
      defaultCurrency: 'usd',
      currencies: { usd: '$9.99' },
    })
  })
})
