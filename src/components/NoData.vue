<template>
    <div class="col-12">
        <div class="emptyState" data-bs-toggle="modal" data-bs-target="#addOrderModal">
            <i class="uil uil-folder-plus emptyStateIcon"></i>
            <div class="emptyStateTitle">No data yet</div>
            <div class="emptyStateText">Nothing to show for the current filters. Click below to add a trade — or try a
                different period.</div>
            <button type="button" class="btn blueBtn btn-sm mt-3" data-bs-toggle="modal"
                data-bs-target="#addOrderModal">
                <i class="uil uil-plus me-1"></i>Add order
            </button>
        </div>
    </div>
</template>

<style scoped>
.emptyState {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 3.5rem 1.5rem;
    background-color: var(--black-bg-5);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease;
}

.emptyState:hover {
    border-color: var(--accent);
    background-color: var(--surface-hover);
}

.emptyStateIcon {
    font-size: 2.6rem;
    color: var(--white-38);
    margin-bottom: 0.6rem;
}

.emptyState:hover .emptyStateIcon {
    color: var(--accent);
}

.emptyStateTitle {
    font-size: 1rem;
    font-weight: 700;
    color: var(--white-87);
    margin-bottom: 0.25rem;
}

.emptyStateText {
    font-size: 13px;
    color: var(--white-60);
    max-width: 360px;
}
</style>
