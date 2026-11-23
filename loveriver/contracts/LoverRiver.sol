// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title loveriver (LOVER) - fixed-supply BEP-20 token for BNB Smart Chain.
/// @notice The entire supply is minted once, to the treasury passed to the
/// constructor. There is no mint, burn, pause, blacklist or owner function, so
/// nobody can change the supply or freeze a balance after deployment.
contract LoverRiver {
    string public constant name = "loveriver";
    string public constant symbol = "LOVER";
    uint8 public constant decimals = 18;

    /// @dev 69,999,999,991 tokens with 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 69_999_999_991 * 1e18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address treasury) {
        require(treasury != address(0), "LoverRiver: treasury is the zero address");
        totalSupply = TOTAL_SUPPLY;
        balanceOf[treasury] = TOTAL_SUPPLY;
        emit Transfer(address(0), treasury, TOTAL_SUPPLY);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "LoverRiver: insufficient allowance");
        if (allowed != type(uint256).max) {
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "LoverRiver: transfer to the zero address");
        uint256 balance = balanceOf[from];
        require(balance >= value, "LoverRiver: insufficient balance");
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
