import { describe, expect, it } from 'vitest'

import { ApiError } from '../../../../utils/error'
import { invoicePaid, subscriptionEvent } from './stripe'

describe('invoicePaid', () => {
  it('maps a valid Stripe invoice payload to domain facts', () => {
    const facts = invoicePaid({
      id: 'in_1',
      customer: 'cus_1',
      subscription: 'sub_1',
      amount_paid: 1000,
      currency: 'usd',
      billing_reason: 'subscription_cycle',
      created: 1_700_000_000,
      status_transitions: { paid_at: 1_700_000_100 },
      lines: { data: [{ price: { id: 'price_plus' } }] },
    })

    expect(facts).toEqual({
      invoiceId: 'in_1',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      providerProductId: 'price_plus',
      amount: 1000,
      currency: 'usd',
      billingReason: 'subscription_cycle',
      createdAt: 1_700_000_000,
      paidAt: 1_700_000_100,
    })
  })

  it('reads subscription and price ids from nested Stripe objects', () => {
    const facts = invoicePaid({
      id: 'in_2',
      customer: { id: 'cus_2' },
      parent: { subscription_details: { subscription: { id: 'sub_2' } } },
      lines: { data: [{ pricing: { price_details: { price: 'price_nested' } } }] },
    })

    expect(facts.subscriptionId).toBe('sub_2')
    expect(facts.customerId).toBe('cus_2')
    expect(facts.providerProductId).toBe('price_nested')
  })

  it('throws INVALID_INVOICE when the payload is not an invoice', () => {
    expect(() => invoicePaid(null)).toThrow(ApiError)
    try {
      invoicePaid({ foo: 'bar' })
    }
    catch (error) {
      expect(error).toMatchObject({ errorCode: 'INVALID_INVOICE', statusCode: 400 })
      return
    }
    expect.fail('expected INVALID_INVOICE')
  })
})

describe('subscriptionEvent', () => {
  it('maps id and status from a Stripe subscription object', () => {
    expect(subscriptionEvent({ id: 'sub_1', status: 'past_due' })).toEqual({
      providerSubscriptionId: 'sub_1',
      status: 'past_due',
    })
  })

  it('throws INVALID_SUBSCRIPTION when the payload has no id', () => {
    expect(() => subscriptionEvent(null)).toThrow(ApiError)
    try {
      subscriptionEvent({ foo: 'bar' })
    }
    catch (error) {
      expect(error).toMatchObject({ errorCode: 'INVALID_SUBSCRIPTION', statusCode: 400 })
      return
    }
    expect.fail('expected INVALID_SUBSCRIPTION')
  })
})
