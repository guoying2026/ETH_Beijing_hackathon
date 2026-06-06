// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library UintQueue {
    struct Queue {
        mapping(uint256 => uint256) data;
        uint256 head;
        uint256 tail;
    }

    function enqueue(Queue storage q, uint256 value) internal {
        q.data[q.tail] = value;
        q.tail += 1;
    }

    function dequeue(Queue storage q) internal returns (uint256 value) {
        require(!isEmpty(q), "queue empty");
        value = q.data[q.head];
        delete q.data[q.head];
        q.head += 1;
    }

    function peek(Queue storage q) internal view returns (uint256 value) {
        require(!isEmpty(q), "queue empty");
        return q.data[q.head];
    }

    function isEmpty(Queue storage q) internal view returns (bool) {
        return q.tail == q.head;
    }

    function length(Queue storage q) internal view returns (uint256) {
        return q.tail - q.head;
    }
}
