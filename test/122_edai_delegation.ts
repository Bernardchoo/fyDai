import { id } from 'ethers/lib/utils'
// @ts-ignore
import helper from 'ganache-time-traveler'
// @ts-ignore
import { expectRevert, expectEvent } from '@openzeppelin/test-helpers'
import { WETH, daiTokens1, wethTokens1, bnify } from './shared/utils'
import { YieldEnvironmentLite, Contract } from './shared/fixtures'

contract('fyDai - Delegation', async (accounts) => {
  let [owner, holder, other] = accounts

  let maturity1: number
  let maturity2: number

  let snapshot: any
  let snapshotId: string

  let treasury: Contract
  let vat: Contract
  let weth: Contract
  let dai: Contract
  let fyDai1: Contract

  beforeEach(async () => {
    snapshot = await helper.takeSnapshot()
    snapshotId = snapshot['result']

    // Setup fyDai
    const block = await web3.eth.getBlockNumber()
    maturity1 = (await web3.eth.getBlock(block)).timestamp + 1000
    maturity2 = (await web3.eth.getBlock(block)).timestamp + 2000

    const env = await YieldEnvironmentLite.setup([maturity1, maturity2])
    treasury = env.treasury
    weth = env.maker.weth
    vat = env.maker.vat
    dai = env.maker.dai

    fyDai1 = env.fyDais[0]

    // Post collateral to MakerDAO through Treasury
    await treasury.orchestrate(owner, id('pushWeth(address,uint256)'), { from: owner })
    const initialCapital = bnify(wethTokens1).add(10).toString()
    await weth.deposit({ from: owner, value: initialCapital })
    await weth.approve(treasury.address, initialCapital, { from: owner })
    await treasury.pushWeth(owner, initialCapital, { from: owner })
    assert.equal((await vat.urns(WETH, treasury.address)).ink, initialCapital.toString())

    // Mint some fyDai the sneaky way
    await fyDai1.orchestrate(owner, id('mint(address,uint256)'), { from: owner })
    await fyDai1.mint(holder, daiTokens1, { from: owner })

    // fyDai matures
    await helper.advanceTime(1000)
    await helper.advanceBlock()
    await fyDai1.mature()

    assert.equal(await fyDai1.balanceOf(holder), daiTokens1, 'Holder does not have fyDai')
    assert.equal(await treasury.savings(), 0, 'Treasury has no savings')
  })

  afterEach(async () => {
    await helper.revertToSnapshot(snapshotId)
  })

  it('redeem is allowed for account holder', async () => {
    await fyDai1.approve(fyDai1.address, daiTokens1, { from: holder })
    await fyDai1.redeem(holder, holder, daiTokens1, { from: holder })

    assert.equal(await treasury.debt(), daiTokens1, 'Treasury should have debt')
    assert.equal(await dai.balanceOf(holder), daiTokens1, 'Holder should have dai')
  })

  it('redeem is not allowed for non designated accounts', async () => {
    await fyDai1.approve(fyDai1.address, daiTokens1, { from: holder })
    await expectRevert(fyDai1.redeem(holder, holder, daiTokens1, { from: other }), 'FYDai: Only Holder Or Delegate')
  })

  it('redeem is allowed for delegates', async () => {
    await fyDai1.approve(fyDai1.address, daiTokens1, { from: holder })
    expectEvent(await fyDai1.addDelegate(other, { from: holder }), 'Delegate', {
      user: holder,
      delegate: other,
      enabled: true,
    })
    await fyDai1.redeem(holder, holder, daiTokens1, { from: other })

    assert.equal(await treasury.debt(), daiTokens1, 'Treasury should have debt')
    assert.equal(await dai.balanceOf(holder), daiTokens1, 'Holder should have dai')
  })

  describe('with delegates', async () => {
    beforeEach(async () => {
      await fyDai1.addDelegate(other, { from: holder })
    })

    it('redeem is not allowed if delegation revoked', async () => {
      expectEvent(await fyDai1.revokeDelegate(other, { from: holder }), 'Delegate', {
        user: holder,
        delegate: other,
        enabled: false,
      })

      await expectRevert(fyDai1.redeem(holder, holder, daiTokens1, { from: other }), 'FYDai: Only Holder Or Delegate')
    })

    it('cannot add delegate again or remove delegate twice', async () => {
      await expectRevert(fyDai1.addDelegate(other, { from: holder }), 'Delegable: Already delegated')

      expectEvent(await fyDai1.revokeDelegate(other, { from: holder }), 'Delegate', {
        user: holder,
        delegate: other,
        enabled: false,
      })

      await expectRevert(fyDai1.revokeDelegate(other, { from: holder }), 'Delegable: Already undelegated')
    })
  })
})
